# Plan D: free releases of our own brick-style packs (BIZ-50..BIZ-64)

Written 2026-11-09 by the Scenario D planner, for the Fable reviewer who merges the plans for A, B and D. Nothing in
this plan has been built yet. It is the work list for implementation agents.

- **Binding context.** The shared brief: the legal guard rails and the process rules. Every implementer brief repeats
  it, and its source copy will live in `docs/plans/README.md`. The legal verdict is in `TASKS-BUSINESS.md`
  "Decisions"; the scenario summary is in `docs/business-scenarios.md`.
- **Channel research.** The facts come from the gitignored reports `output/business-1106/3-pricing-gtm.md` (cited as
  **[GTM §n]**) and `4-create-list-sell.md` (cited as **[CLS §n]**).
- **What D is.** Free releases of OUR OWN original brick-style packs, with tips and donations that unlock nothing. D
  is the audience funnel for the paid Marketplace packs (A) and the converter (B).
- **What D is not.** It never releases official LEGO sets, licensed themes or minifigures. It never sells anything
  off the Marketplace: Mojang's usage guidelines permit distributing a mod, never selling one [CLS §2.1].
- **Nothing outward without the user.** No upload, account sign-up, page, post, tag push, Worker deploy or R2 publish
  happens without the user's approval for that instance. The release tooling prepares bundles and checklists. It
  contains no upload code at all (WP D-08 tests that).

---

## 1. What exists today (measured 2026-11-09)

| Area | Fact | Where |
|---|---|---|
| Pack namespace | Every pack uses the shared `craftmatic:` namespace. | `web/src/engine/mcpack.ts:41`, `web/src/engine/ldraw-entity-compiler.ts:52` |
| Pack identity | Manifest uuids are `deterministicUuid("craftmatic.addon.<role>:" + packIdentity(stem, label))`. The identity is the label's words, so **renaming a label mints new uuids**. | `mcpack.ts:170`, `web/src/engine/playable-addon.ts:2622-2623` |
| Pack version | `packVersionAt()` = `[YYMM, DDHH, MMSS]` of the build instant, e.g. 2026-11-09 14:30:59Z gives `[2611, 914, 3059]`. It is not semantic, and it is not reproducible. | `web/src/engine/pipeline-version.ts:219`, called at `playable-addon.ts:2608` |
| Pipeline stamp | A sha256/12 content hash over the export closure, plus the last-touching commit and a `+dirty` flag. It goes into the pack NAME ("Label — Playable (2026-10-16 feb168d9)") and into `craftmatic-provenance.json`. | `pipeline-version.ts:1-31`, `:168`, `:185`; `playable-addon.ts:2629`; `scripts/pipeline-stamp.ts` |
| Manifests | No `pack_scope`, and no RP→BP dependency: only the BP depends on the RP. `min_engine_version` is `[1,26,40]`. Script modules are `@minecraft/server` 2.9.0 and `-ui` 2.1.0. | `playable-addon.ts:2624-2626` |
| Player-facing text | The RP description says "one flat 16x16 colour swatch per LEGO colour". The BP README mentions minifigs, "the set's own LEGO parts" and "10300 Time Machine". | `playable-addon.ts:2626`, `:4099` |
| Zip determinism | Fixed DOS date 1980-01-01, but deflate goes through the runtime's `CompressionStream`, whose bytes can differ between runtimes. | `web/src/engine/zip-utils.ts:89-96`, `:141` |
| Structural gate | `scripts/_mcaddon_check.py` checks manifests, BP→RP dependency, script entry, identifiers, dropped components, hit boxes, lang hints, fly sound, box-UV sizes, geometry and texture references, and block states. It caps permutations at **65,536**; Mojang's cooperative guideline is **10,000** [CLS §1.3]. It does not check `pack_scope`, the RP→BP dependency, namespace uniqueness, folder layout, vanilla-path overrides, size or file count. 0.19 s per pack (measured on `60221-diving-yacht.mcaddon`). | `scripts/_mcaddon_check.py:253`, `:267` |
| Microsoft validator | `@minecraft/creator-tools` **0.21.0** on npm, bin `mct`, command `mct validate -i <dir>`. It needs Node >= 22 (this box: v25.8.2) and a one-time `mct eula`. | npm registry, read 2026-11-09 |
| Part library | CLI builds read Studio's library (`LDRAW_ROOT = C:/git/clego/extracted/studio_release/app/ldraw`), and the resolver probes `UnOfficial/` (Studio-only, which its EULA forbids redistributing). The official LDraw library sits in `C:/git/clego/ldraw_ref/official` (24,736 parts, extracted from `_archives/complete.zip`, sha256 prefix `d2a695868ed2b395`, 37,099 entries). Each official file carries `0 Author:` and `0 !LICENSE Licensed under CC BY 4.0`. No part-source path is reported per part; only `unresolvedParts` and `substitutedParts` are. | `scripts/_playable_ref.ts:39`; `web/src/engine/ldraw-geometry.ts:192-200`; `ldraw-entity-compiler.ts:408`, `:447` |
| Offline renderer | `scripts/_pack_render.ts` renders a built pack with a software rasteriser: `--views=N` turntable strips, `--walk-away`, `--lod`, `--uvfloor`. 8 views at 640x480 took **1.7 s** (measured on 60221). The picture **may be the game's mirror image**: JSON X is not mirrored (`:24-26`). It has no anti-aliasing, and the camera does not auto-fit the frame. | `scripts/_pack_render.ts` |
| Related tools | `_cockpit_view.ts` (the hotbar-9 view), `_walk_line.ts`, `_render_fault_audit.ts`, `_box_uv_loss.ts`, `_seat_scale_check.ts`, `sim.ts`. ffmpeg, ImageMagick, sharp 0.33 and playwright-core 1.62 are all installed. | `scripts/`, `package.json:94,105` |
| Vehicle pack size | Zipped: 167 KB (60221 yacht) and 215 KB (7140 X-wing). A car sampler is far under the 25 MB / 3,500-file guideline. | `output/device-round-2026-10-16zl/packs-feb168d9/` |
| Website | craftmatic.click is GitHub Pages behind Cloudflare: HTML `max-age=600`, and `/downloads/*` returns `application/octet-stream` with `cf-cache-status: DYNAMIC` and **no download counter**. Vite builds only `index.html`: there is no `rollupOptions.input`, so `web/showcase.html` is not in `dist`. The service worker caches **every** successful GET (network-first), multi-MB downloads included. | `curl -I` 2026-11-09; `web/vite.config.ts:51`; `web/public/sw.js:49-66` |
| Site look | The dark tokens already in use are `--bg #0a0a14`, `--accent #F2CD37`, Inter and JetBrains Mono. | `web/showcase.html:14-25` |
| Worker | `worker/ldraw-omr.js` (JS), with routes in `wrangler.toml`, R2 binding `MODELS` (`:68`) and a Durable Object. No Analytics Engine binding. | `wrangler.toml` |
| A live LEGO-named download | `craftmatic.click/downloads/Craftmatic-Lego-Pack.mcpack` answers HTTP 200, and the LEGO tab links to it (`web/src/ui/lego.ts:2182-2195`: "install LEGO ABS plastic textures"). Out of D's scope, but see Risk R3. | `curl -I` 2026-11-09 |
| Repo | `tribixbite/craftmatic` is **PUBLIC** (`gh repo view`), MIT (`LICENSE`), and has no git tags. | `gh`, `git tag` |
| Ledger | Section 17 holds `BIZ-01..04` and `BIZ-65`. The ranges A = BIZ-05..29, B = BIZ-30..49 and D = BIZ-50..64 are reserved there. | `REQUIREMENTS.md:290-294` |

---

## 2. Gaps D must close

1. **Release identity.** Uuids keyed on a label, plus a date-based version, cannot give "stable uuids, semantic
   versions, never drop a shipped entity" (the cooperative guideline: "When making updates, don't change namespaces",
   and keep old entity types [CLS §1.2]).
2. **Reproducibility.** The build clock (`packVersionAt`, `builtAt`, `computedAt`), runtime deflate, the network part
   mirror and Studio's library all make a rebuild differ.
3. **Licence safety.** Nothing proves which library file each part came from, and nothing writes the CC BY
   attribution.
4. **Player-facing text.** It carries LEGO words, set numbers and dev stamps.
5. **Validator coverage.** Neither the Marketplace-grade rules nor CurseForge's packaging rules are gated.
6. **Distribution.** There are no release bundles, checksums, changelog, listing copy or images.
7. **Website.** There is no packs gallery, no counted downloads, no funnel and no privacy page.
8. **Telemetry.** No counters, and no weekly report.

These gaps overlap A's Marketplace work, listed in `docs/business-scenarios.md` "Work on our side before a listing":
the namespace, folders, vanilla textures, `pack_scope`, our own figure, placement into air and undo, and names.
**D depends on those packages and does not duplicate them.** Where D needs one of them first, the dependency is named
"A:<topic>" below, and the Fable merge maps it to A's WP id. The part-source licence gate (D-04) is shared with A's
item 10. D owns it, and A consumes it.

---

## 3. Architecture

### 3.1 Module map and boundaries

```
release/                                   committed DATA (no code)
  products/<product>.json                  ProductRecord: identity, semver history, content, toolchain pins
  identity-ledger.json                     append-only: every released version's uuids, namespace, entity/block/item ids, sha256
  changelogs/<product>.md                  curated Keep-a-Changelog text (the source of truth for notes)
  channels/<channel>.json                  ChannelSpec: fields, limits, image presets, checklist template
  copy/<product>/*.md                      listing copy, install guide, controls, FAQ (lint-clean)
  cadence.json                             ReleaseCadence: SKU matrix free/paid, calendar, A/B coupling
  media/<product>.storyboard.json          trailer shot list (consumed by the device-round brief)

web/src/release/                           PURE TypeScript (no fs, no network): typechecked by typecheck:web
  types.ts                                 every interface below
  semver.ts                                parse/compare/bump; semver -> manifest triple
  product.ts                               load+validate ProductRecord; dev vs release identity; uuid resolution
  identity-ledger.ts                       append rules: version rises, uuids/namespace frozen, no shipped id dropped
  notices.ts                               Mojang disclaimer, publisher/contact block, LDraw CREDITS from a PartSourceLedger
  forbidden-terms.ts                       lint of every player-facing / listing string (LEGO marks, set numbers, licensed themes)
  changelog.ts                             curated notes + conventional-commit extraction -> per-channel renderings
  checksums.ts                             SHA256SUMS text (GNU format), ReleaseRecord assembly
  channels/{curseforge,mcpedl,itch,kofi,patreon,affiliate,site}.ts   bundle builders: ChannelBundle from ProductRecord+copy+media
  media-presets.ts                         image/video presets per platform, all <2000 px and <4 MB
  catalog.ts                               SiteCatalog entries (the website's data) from ReleaseRecords

web/src/engine/ (EXISTING, minimal seams)
  playable-addon.ts                        + options.release?: ReleaseBuildContext (version, uuids, clock, texts, strip diagnostics)
  pipeline-version.ts                      + clock injection (SOURCE_DATE_EPOCH) for builtAt/computedAt
  zip-utils.ts                             + options.deflate injection (pako, deterministic)
  ldraw-geometry.ts / ldraw-entity-compiler.ts   + PartSourceLedger: resolved file, licence line, authors per part

scripts/ (CLI, Node/Bun side: fs, git, child processes)
  release.ts                               init-product | prepare | finalize | verify | status   (ONE command; no upload code)
  release-mctools.ts                       runs `mct validate`, parses to McToolsReport
  media-turntable.ts                       turntables, posters, thumbnails per preset (reuses the sim snapshot rasteriser)
  biz-weekly-report.ts                     read-only telemetry -> output/biz-weekly/<ISO week>.md
  _mcaddon_check.py                        + --release mode (extended IN PLACE)

web/packs/index.html, web/src/site/*.ts    packs gallery, pack detail, downloads list, privacy page (Vite multi-page)
worker/downloads.ts                        /get/* (counted download), /go/* (counted click-out) -> Analytics Engine; no PII

output/releases/<product>/<version>/       gitignored (output/* in .gitignore:60): the prepared upload bundle
output/biz-weekly/                         gitignored: weekly reports + history.jsonl
```

**Boundaries.**
- `web/src/release/**` is pure: it gets bytes and records and returns bytes and records. It can be tested without
  disk or git.
- `scripts/release.ts` is the only code that touches git, the filesystem and child processes.
- The engine learns about releases only through `ReleaseBuildContext`, so the LEGO tab's dev exports are unchanged
  when it is absent.
- The website reads only `catalog.json` and the media files.
- The Worker reads only the catalog's allow-list.
- Telemetry reads only public counters, or the credentials the user grants, and it is GET-only.

### 3.2 Data types (`web/src/release/types.ts`)

```ts
/** A semantic version. Bedrock manifests take [major, minor, patch]; no pre-release tag ever reaches a manifest. */
export interface SemVer { major: number; minor: number; patch: number }

/** Frozen per-product Bedrock identity, minted ONCE by `release.ts init-product`, never derived from a label. */
export interface ProductIdentity {
  /** `<creator>_<pack>`, the namespace for every id in the add-on [CLS §1.3]. Null until the user decides (Q1): release refuses. */
  namespace: string | null;
  uuids: { bpHeader: string; bpData: string; bpScript: string; rpHeader: string; rpResources: string };
  /** Folder prefix inside the .mcaddon, e.g. `BrickSampler_BP/`. Frozen with the uuids. */
  folderStem: string;
}

/** One product = one CurseForge project = one itch page = one catalog card. */
export interface ProductRecord {
  id: string;                                   // 'sampler'
  displayName: string;                          // player-facing, lint-clean, no "Minecraft" as the dominant name
  tier: 'free' | 'paid-marketplace';            // D ships only 'free'; A owns 'paid-marketplace'
  identity: ProductIdentity;
  /** A's design ids (with provenance logs) that the pack contains. */
  designs: Array<{ designId: string; role: 'vehicle' | 'door-kit' | 'seat-kit' | 'landmark' | 'ride' | 'prop' }>;
  /** Pinned inputs that make a build reproducible. */
  toolchain: {
    bun: string;                                // exact `bun --version`
    lockfileSha256: string;                     // bun.lock
    ldrawLibrary: { archive: 'complete.zip'; sha256: string; root: string };  // official only
    scriptModules: { server: string; serverUi: string };   // stable track only
    minEngineVersion: [number, number, number];
  };
  versions: ReleasedVersion[];                  // newest last; mirrors identity-ledger.json
  publisher: { name: string; contactEmail: string } | null;   // usage guidelines: name + a non-chat contact (Q8)
}

export interface ReleasedVersion {
  version: SemVer;
  commit: string;                               // full sha the bytes were built from
  tag: string | null;                           // `<product>-v<semver>`, set when the user tags (finalize)
  sourceDateEpoch: number;                      // commit time, drives every clock in the build
  artifacts: Array<{ file: string; sha256: string; bytes: number }>;
  deviceEvidence: string | null;                // device-round id that played THIS sha256 (required at finalize)
}

/** What the engine needs to emit a release pack instead of a dev pack. */
export interface ReleaseBuildContext {
  productId: string;
  version: SemVer;
  identity: ProductIdentity & { namespace: string };
  /** Seconds since epoch; replaces Date.now() for builtAt, computedAt and anything stamped. */
  clock: number;
  texts: { packName: string; bpDescription: string; rpDescription: string; readme: string; lang: Record<string, string> };
  /** Release packs ship provenance (sanitised) but never craftmatic-diagnostics.json. */
  stripDiagnostics: true;
  deflate: (data: Uint8Array) => Uint8Array;     // pako.deflateRaw level 9
}

export interface PartSourceEntry {
  part: string;                                  // partStem() id
  file: string;                                  // library-relative path actually read
  library: 'ldraw-official' | 'ldraw-unofficial' | 'studio' | 'mirror' | 'synthesised';
  licence: string | null;                        // the `0 !LICENSE` line verbatim
  authors: string[];                             // `0 Author:` (+ `!HISTORY` contributors not required by CC BY)
}
export type PartSourceLedger = PartSourceEntry[];

export interface IdentityLedgerEntry {
  product: string; version: string; namespace: string;
  uuids: ProductIdentity['uuids'];
  entityIds: string[]; blockIds: string[]; itemIds: string[];
  sha256: Record<string, string>;
}

export interface ValidationReport {
  structural: { ok: boolean; problems: string[] };        // _mcaddon_check.py --release
  mctools: { errors: number; warnings: number; rules: Array<{ id: string; severity: string; message: string }> } | 'not-run';
  forbiddenTerms: Array<{ file: string; term: string; context: string }>;
  licence: { ok: boolean; offending: PartSourceEntry[] };
  sim: { scenarios: Record<string, 'pass' | 'fail'>; report: string };
  size: { uncompressedBytes: number; files: number };
}

export interface ChannelBundle {
  channel: 'curseforge' | 'mcpedl' | 'itch' | 'kofi' | 'patreon' | 'affiliate' | 'site';
  fields: Record<string, string | string[] | boolean>;    // exactly the form's fields
  files: Array<{ path: string; purpose: string; width?: number; height?: number; bytes: number }>;
  checklist: ApprovalItem[];
}

/** An outward action. Every one starts unchecked and names the person who must approve it. */
export interface ApprovalItem {
  id: string;                                    // 'cf.create-project'
  action: string;                                // human sentence
  exactCommandOrUrl: string;                     // what the user (or an agent with approval) runs/opens
  approver: 'user';
  approved: false;
  evidenceAfter: string;                         // what to record once done (URL, project id)
}

export interface SiteCatalogEntry {
  product: string; version: string; title: string; oneLiner: string; tags: string[];
  downloads: Array<{ label: string; href: string /* /get/... */; sha256: string; bytes: number }>;
  media: { poster: string; turntable: { webm: string; mp4: string }; screenshots: string[]; og: string };
  changelogHtml: string; creditsUrl: string; disclaimer: string;
  outbound: { marketplace?: string; converter?: string; kofi?: string; patreon?: string };  // /go/... links
}

export interface WeeklyMetric { source: string; metric: string; value: number | 'not granted' | 'unavailable'; delta?: number; unit: string }
```

### 3.3 The release flow (`bun scripts/release.ts prepare <product>`)

The command runs these steps in order and stops at the first failing gate. It writes
`output/releases/<product>/<version>/` and nothing else.

1. **Preconditions.**
   - The working tree is clean (the pipeline stamp is not dirty, and `git status --porcelain` is empty).
   - The ProductRecord validates. Its `namespace` is not null, and its version rises above the identity ledger's.
   - The toolchain pins match: `bun --version`, the lockfile hash, and the LDraw archive sha256.
2. **Fresh worktree.** `git worktree add .worktrees/release-<product>-<ver>-<n> <commit>`, with a NEW `<n>` every run.
   It is never removed by the tool; the binding rule forbids recursive deletes.
3. **Build** inside the worktree, offline:
   - `CRAFTMATIC_LDRAW_MIRROR=off`, the LDraw root set to `ldraw_ref/official`, then unofficial (licence-checked);
     never Studio.
   - `SOURCE_DATE_EPOCH` set to the commit time.
   - The ReleaseBuildContext passed to `buildPlayableAddon`.
   - One build at a time (CLAUDE.md: parallel exports silently substitute parts).
4. **Gates** (the ValidationReport, written to `validation.json`). Each one fails the run:
   - `_mcaddon_check.py --release` reports 0 problems.
   - `mct validate` reports 0 Errors.
   - The forbidden-terms lint finds 0 hits over every text file in the archive AND every listing and copy file.
   - The licence gate finds every PartSourceEntry in `ldraw-official`, or in `ldraw-unofficial` with a CC BY licence
     line.
   - `unresolvedParts` and `substitutedParts` are both empty.
   - `sim.ts --scenario=child-play` and `--scenario=vehicles` pass.
   - `_render_fault_audit.ts` and `_box_uv_loss.ts` are under thresholds.
   - `_seat_scale_check.ts --all` has no ON-TOP faults.
   - Size is 25 MB or less uncompressed, with 3,500 files or fewer.
5. **Artifacts.**
   - `dist/<slug>-<ver>.mcaddon`.
   - `dist/<slug>-<ver>.zip`: the same two pack folders, zipped without an extra root folder, for CurseForge's "zip
     without a root folder" rule [CLS §2.2]. Whether CurseForge Bedrock accepts `.mcaddon` directly is unverified, so
     both are prepared.
   - `SHA256SUMS` in GNU format, which `sha256sum -c` accepts.
   - `release.json` (the ReleasedVersion without a tag or device evidence).
   - `CHANGELOG.md`, `NOTICE.txt` (the disclaimer) and `CREDITS-LDRAW.txt`.
6. **Media** (D-11): turntables, posters and per-channel thumbnails into `media/`.
7. **Channel bundles** (D-09): `channels/<channel>/{fields.json, description.md, images…, CHECKLIST.md}`.
8. **Catalog entry** (D-12): `site/catalog-entry.json`.
9. **Approval sheet.** One `APPROVAL.md` lists every outward ApprovalItem, unchecked, in the order to do them:
   1. the tag;
   2. the R2 upload;
   3. the Worker deploy;
   4. the site deploy;
   5. the CurseForge project and file;
   6. the MCPEDL link;
   7. itch;
   8. Ko-fi, Patreon and the affiliate programme.

**The release candidate IS the release.** The bytes the device round plays are built with the final semver and the
release identity. After that:
1. The user tags the commit: `git tag -a sampler-v1.0.0 <commit>`. The script prints this command and never runs it.
2. `release.ts finalize` rebuilds from the tag in a new worktree and requires an identical sha256.
3. It records `deviceEvidence`, then appends to `identity-ledger.json` in a commit for the user to approve.

`release.ts verify <product> <version>` repeats the rebuild at any time, so anyone can prove a published file came
from that tag.

**Dev builds of a product never collide with releases.** A dev build of a release product gets a separate identity
(the uuid seed salted with `:dev`, and a name suffix "(dev <stamp>)"). The reason: a date-based dev version such as
`[2611, …]` ranks above `[1,0,0]`, and Minecraft only replaces an installed pack when the version rises
(`pipeline-version.ts:20-31`).

---

## 4. Channels: fields, images, copy, categories, checklists

**Working names.** The plan writes `<Brand>` for the brand and creator name and `<ns>` for the namespace, because both
are the user's decision (Q1). The copy below uses **"Brickcraft"** and the namespace **`bkc_sampler`** only as
stand-ins to show the shape. They are **not chosen** and must be replaced before anything is prepared for real.

**Every listing carries:**
- the disclaimer "NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT."
  [CLS §2.1];
- the publisher's name and a non-chat contact address [CLS §2.1];
- the LDraw attribution;
- no LEGO name, set number, minifig or licensed theme;
- "Minecraft" only in a secondary position, and never the Minecraft logo.

**Every image is a render or a device capture,** never AI-generated or AI-upscaled: CurseForge requires a visible
disclaimer on AI showcase images [CLS §2.2]. Every image file is under 2000 px on each side and under 4 MB, which
D-11's tests enforce.

### 4.1 CurseForge (and MCPEDL, which uploads through it)

**Fields** [CLS §2.2; categories read live 2026-11-09 from curseforge.com/minecraft-bedrock/addons]:

| Field | Value prepared |
|---|---|
| Game | Minecraft Bedrock |
| Class | Addons |
| Name (unique, no game name, no version) | `<Brand> Brick Sampler: Drive, Open, Sit` |
| Summary (one line; the form's length limit is unmeasured, so D-09 reads it off the form at approval time) | "A free brick-built car you can drive, doors that swing open and chairs you can sit on, placed anywhere with one wand." |
| Main category | Technology |
| Additional categories (up to 4) | Roleplay, Utility, Multiplayer, Vanilla+. Measured category list: Armor/Tools/Weapons, Cosmetics, Data Packs, Fantasy, Food, Horror, Magic, Maps, Minecraft Addon Maker, Multiplayer, Performance, Roleplay, Skins, Survival, Technology, Texture Packs, Utility, Vanilla+. |
| Comments | On |
| Experimental | **Off** (experimental projects do not sync) |
| Licence | Proposed All Rights Reserved for the pack, because A sells the same engine. Q2 asks the user and the lawyer. |
| Logo | PNG, 1:1, at least 400x400 [support.curseforge.com "Project Submission Guide"]. Prepared at 800x800. |
| Images tab | 6 in-game screenshots at 1600x900, plus 2 offline renders labelled "offline render" |
| File | `.zip` with no root folder, or `.mcaddon` (to verify), release type **Release**, supported game versions 1.26.40+ (`min_engine_version`), changelog per file (D-06) |
| Rewards | Opt in (1 point = $0.05, PayPal from $5) [CLS §2.2] |

**MCPEDL** [CLS §2.3]:
- the same slug as the MCPEDL link;
- a thumbnail file named exactly `MCPEDL`, prepared at 1280x720 (MCPEDL's preferred size is unmeasured, so verify it
  at approval);
- "third-party sharing" on, and Rewards on;
- the MCPEDL profile linked to the CurseForge account under connected accounts;
- direct download only: never an ad-gated link.

**Description draft** (`release/copy/sampler/curseforge.md`; Markdown, to check against the CurseForge editor):

```md
## Drive it. Open it. Sit in it.

The **Brick Sampler** is a free taste of what brick-built builds can do in Bedrock when they are more than blocks:

- **A drivable brick car**: steer with the joystick or A/D, boost with Jump, and it climbs kerbs and slides along walls
  instead of getting stuck. Drag to look around; the chase camera swings back behind you.
- **A door kit**: hinged doors and windows that swing open when you tap them and stay open after a reload.
- **A seat kit**: chairs, a bench and a sofa you can sit on (sneak to stand up).
- **One Brick Wand** places everything: preview it as a ghost, rotate it, pick a size from 25% to 400%, place it, and
  undo if you change your mind. It only places into air.

### Install
1. Download the `.mcaddon` and open it. Minecraft imports both packs.
2. Create or edit a world, then turn on the **behaviour pack** under Add-Ons. The resources pack follows.
3. Find the **Brick Sampler Wand** in the Creative inventory.

Phones: open the file from your Downloads folder. iPhone/iPad: tap it, then "Open in Minecraft". Consoles cannot
import add-ons directly: add it to a world on a PC and upload that world to a Realm.

### Works with
Minecraft Bedrock 1.26.40 or newer. Works alongside other add-ons. No experiments needed.

### Credits
Brick shapes come from the LDraw.org Parts Library (CC BY 4.0); see CREDITS-LDRAW.txt in the download for every
part author. Every design in this pack is our own.

### Support the project
Everything here is free and stays free; nothing is locked behind a tip.
[Ko-fi](https://craftmatic.click/go/kofi?ref=cf) · [Dev log](https://craftmatic.click/go/patreon?ref=cf) · [All packs](https://craftmatic.click/packs/?ref=cf)

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
Published by <Brand>, contact: <email>.
```

Donation links sit at the bottom, "civil in size", as CurseForge asks [CLS §2.2]. They go through `/go/*`, so
click-outs are counted without cookies.

**Prepared, awaiting approval** (generated as `channels/curseforge/CHECKLIST.md`):
- [ ] `cf.account`: the user creates or uses an authors.curseforge.com account.
- [ ] `cf.create-project`: fill in the fields above from `fields.json`.
- [ ] `cf.images`: upload the logo and the screenshots.
- [ ] `cf.file`: upload `dist/…zip` or `.mcaddon` with `CHANGELOG.md` as the changelog.
- [ ] `cf.rewards`: opt in; record the PayPal payout method.
- [ ] `mcpedl.link`: link the MCPEDL profile, set the slug, upload the `MCPEDL` thumbnail, turn on third-party sharing.
- [ ] `cf.record`: write the project id into `release/channels/curseforge.json` (the weekly report needs it).

### 4.2 itch.io (free download)

**Fields:**

| Field | Value prepared |
|---|---|
| Title | `<Brand> Brick Sampler` |
| Project URL | `<brand>.itch.io/brick-sampler` |
| Short description / tagline | "Drive a brick car, open brick doors, sit on brick chairs. Free Bedrock add-on." |
| Classification | Game mods. Verify the exact label in the form. |
| Kind of project | Downloadable |
| Release status | Released |
| Pricing | **No payments** (recommended). "$0 or donate" is the alternative (Q4): Mojang's terms do not cover off-Marketplace payments for mods [GTM §2.1], so tips go to Ko-fi. |
| Uploads | `.mcaddon`, tagged Windows and Android (itch has no iOS tag; the description covers iOS) |
| Description | Same body as CurseForge, with images inline |
| Genre / tags | Simulation; `minecraft-bedrock`, `addon`, `vehicles`, `bricks`, `building`, `mod`, `free`. Verify the tag limit. |
| Cover image | **630x500** (itch.io "Your first itch.io page", read 2026-11-09). Also a 1260x1000 version for high-dpi. |
| Screenshots | 5 at 1600x900, plus the turntable GIF, which must stay under 4 MB |
| Community | Comments |
| Visibility | Draft until approval, then Public |

**Prepared, awaiting approval:**
- [ ] `itch.account`: the user's account.
- [ ] `itch.page`: create the page from `fields.json`, as a Draft.
- [ ] `itch.upload`: upload in the browser, or use the prepared `butler push output/releases/sampler/<ver>/dist <user>/brick-sampler:mcaddon --userversion <ver>`. butler is not installed; installing it and `butler login` are the user's.
- [ ] `itch.publish`: switch Draft to Public.
- [ ] `itch.record`: write the game id into `release/channels/itch.json`.

### 4.3 Ko-fi (tips that unlock nothing)

- **Fields:** page name, about text, avatar (prepared 512x512), cover (prepared 1600x400, to verify against the form),
  and the "Ko-fi free" plan, which takes 0 % of tips [GTM §2.2].
- **No shop items. No membership tiers with content.**
- **Copy draft:** "I build free brick-style add-ons for Minecraft Bedrock: cars you can drive, doors that open,
  coasters you can ride. Everything I release for free stays free. A tip buys my time to make the next one; it does
  not unlock anything."
- **Checklist:**
  - [ ] `kofi.account`
  - [ ] `kofi.page`
  - [ ] `kofi.webhook`: optional; it lets the Worker count supporters and needs a Worker secret (D-15)
  - [ ] `kofi.record`

### 4.4 Patreon (a dev log, never paywalled packs)

- **Tiers.** A free follower tier, plus one supporter tier: "Brick Supporter", around $3, decided by the user.
  - Benefits: your name in the pack's CREDITS (thanks only, which is allowed: no "something only they can use"
    [GTM §2.1]), polls on the next design, and behind-the-scenes renders and dev-log posts.
  - **Never** early or exclusive pack files.
- **Fees.** 10 % plus processing [GTM §2.2].
- **Images.** Cover prepared at 1600x400 and avatar at 512x512, both to verify against the form.
- **Copy draft:** "Follow how brick-built Minecraft add-ons get made: the physics of a coaster loop, why a door
  needs a hinge, what a phone can draw. Every pack stays free for everyone; support pays for the time."
- **Checklist:**
  - [ ] `patreon.account`
  - [ ] `patreon.page`
  - [ ] `patreon.tiers`
  - [ ] `patreon.first-post`, prepared from the release notes
  - [ ] `patreon.record`

### 4.5 CurseForge rewards and the Minecraft affiliate programme

- **CurseForge rewards.** Covered in 4.1. Points expire after 3 years, and accrual pauses after 60 days without a
  login [CLS §2.2]. The weekly report reminds the user before the 60 days run out.
- **Affiliate programme.** Through impact.com: 5 % on Marketplace items bought through a web link, subscriptions
  excluded, answers within about a month [GTM §1.5].
  - **Prepared:** the application text (portfolio: the sampler page and download counts), the disclosure line
    "Links to the Minecraft Marketplace may earn us a commission", and the `/go/marketplace/<sku>` redirect.
  - **Checklist:**
    - [ ] `aff.apply`
    - [ ] `aff.links`: paste the impact.com link templates into `release/channels/affiliate.json`
    - [ ] `aff.record`
  - Once A is live, the link is used only on our own site, video descriptions and listings. **It never appears
    in-game**: the cooperative guidelines and kid safety forbid external links in packs [CLS §3, T18].

### 4.6 Short video (reach, not money)

The pricing report treats short videos as the main reach channel: three vertical clips a week [GTM §5]. D prepares
the clips (D-11, D-16). Posting is outward, and every post needs approval. YouTube thumbnails are prepared at
1280x720 and under 2 MB.

---

## 5. craftmatic.click pages

**Pages:**
- `/packs/`: the gallery;
- `/packs/<id>/`: the pack detail page;
- `/downloads/`: a plain list of every release with sha256 and size, machine-friendly;
- `/privacy/`;
- `/packs/catalog.json`: the data.

They are built by Vite as multi-page inputs: `web/vite.config.ts` gains `rollupOptions.input`. A small Vite plugin
emits the static detail pages from `catalog.json` at build time, so each has its own `<title>`, OG image and
description for link previews, and no generated HTML is committed.

**Design:**
- **Dark by default,** with the tokens of `web/showcase.html:14-25`. Add `<meta name="darkreader-lock">`; the
  global lesson is that Dark Reader re-tints an already dark UI.
- **Mobile first:**
  - 16 px side gutters, no horizontal scroll at 360 px;
  - touch targets of at least 44 px;
  - card grid `repeat(auto-fill, minmax(280px, 1fr))`;
  - screenshot carousel with CSS scroll-snap.
- **Video:** the turntable plays as `<video muted loop playsinline preload="none" poster>`, with WebM and MP4
  sources. Autoplay happens only when in view and when `prefers-reduced-motion` is not set.
- **Detail page contents:**
  - the hero video;
  - the feature list;
  - controls for touch, keyboard and controller;
  - the install guide per platform (Windows, Android, iOS, consoles through a Realm [CLS §2.4]);
  - the changelog;
  - the download button (`/get/...`), with the sha256 under it;
  - credits, and the disclaimer;
  - "Support" (Ko-fi, Patreon);
  - "Make your own from your brick model" (the converter, B, once it is live);
  - "Full packs on the Marketplace" (A, once live, with the affiliate disclosure).
- **Funnel blocks, config-gated.** `web/src/site/site-config.ts` holds `newsletter`, `discord`, `kofi`, `patreon`,
  `marketplace` and `analytics`, all `null` until the user approves. A null entry renders nothing: no dead buttons,
  no "coming soon" pages.
  - **Newsletter:** a double opt-in form posting to the chosen provider. Buttondown is suggested for its no-tracking
    option (Q5). The form adds age wording: "13 or older, or ask a parent". Q5 asks the user and the lawyer about
    children's privacy.
  - **Discord:** an invite link, plus a prepared server template document (channels: `#announcements`, `#showcase`,
    `#help`, `#ideas`; rules; roles). The user creates the server.
- **Analytics, private by design:**
  1. **Cloudflare Web Analytics.** Cookieless and free. The beacon snippet is injected only when
     `analytics.cfBeaconToken` is set (Q6).
  2. **Worker counters** for downloads and click-outs (D-13), with no cookies, no IP and no user agent stored.
  - The `/privacy/` page states exactly what is counted.
  - No third-party trackers, no ad networks, no fingerprinting.
- **Service worker.** Exclude `/get/`, `/go/`, `*.mcaddon`, `*.zip`, `*.mp4` and `*.webm` from the cache-everything
  fetch handler (`web/public/sw.js:49-66`), so a 3 MB pack is never stored twice.
- **Cache busting.** Every media and download URL carries the version or content hash. The global lesson: Cloudflare
  keeps static assets 4 h while HTML is held 600 s.
- **Hosting the binaries.** Recommended: a new R2 bucket `craftmatic-releases`, served through the Worker's `/get/*`
  so that every download is counted. A GitHub Release per tag is an optional mirror. Its `download_count` is public,
  but publishing it is a tag push, which is outward (Q3). Do **not** commit binaries into `web/public/downloads/`:
  they bloat the repo and nothing counts them.

---

## 6. Media production

**Offline renders (D-11).** `bun scripts/media-turntable.ts <pack.mcaddon> --preset=<name|all> --out=<dir>`.
- It reuses the snapshot rasteriser that `_pack_render.ts` uses (`renderActorsDetailed`, `snapshot.ts`). It does not
  fork the script: `_pack_render.ts` keeps its QA role, and the shared framing and mirroring logic moves into a module
  both scripts import.
- **Additions:**
  - `--game-frame` mirrors JSON X, so a picture matches what the game shows (`_pack_render.ts:24-26` admits the
    mirror). Marketing images must not show mirrored decals.
  - Supersampling: render at 2x, downscale with sharp's Lanczos filter.
  - The camera auto-fits the model's bounds, with a margin.
  - A ground plane with a contact shadow, and a brand backdrop gradient.
  - Turntables: N frames (default 72, which is about 15 s at the measured 8 views per 1.7 s), assembled with ffmpeg
    into WebM (VP9), MP4 (H.264, yuv420p, `+faststart`) and an optimised GIF. Plus a poster in WebP and PNG.
- **Presets** (`media-presets.ts`). Every one is under 2000 px a side and under 4 MB, and that is tested:

| Preset | Size | Format | Use |
|---|---|---|---|
| `cf-logo` | 800x800 | PNG | CurseForge logo (at least 400x400, 1:1) |
| `screenshot` | 1600x900 | PNG/JPG | CurseForge and itch screenshots, site carousel |
| `itch-cover` / `itch-cover-2x` | 630x500 / 1260x1000 | PNG | itch cover |
| `mcpedl-thumb` | 1280x720 | PNG, named `MCPEDL` | MCPEDL thumbnail (size to verify) |
| `og` | 1200x630 | JPG | link previews on the site |
| `yt-thumb` | 1280x720 | JPG, under 2 MB | video thumbnails |
| `banner` | 1600x400 | JPG | Patreon and Ko-fi covers (to verify) |
| `avatar` | 512x512 | PNG | profiles |
| `turntable` | 1080x1080 and 1080x1920 (vertical) | WebM/MP4/GIF | site hero, shorts |

**Trailer storyboard (D-16).** Stored in `release/media/sampler.storyboard.json`: 30-45 s, 9:16 and 16:9 cuts.
1. 0-3 s: cold open. The wand places the car (ghost, then solid).
2. 3-10 s: drive past the camera and climb a kerb.
3. 10-16 s: cockpit view (hotbar 9).
4. 16-22 s: walk up and tap the door, which swings open.
5. 22-27 s: sit on the sofa (third person).
6. 27-32 s: size the car to 400 % and drive it.
7. 32-38 s: the offline turntable over the end card: name, "Free", and the disclaimer.

**Capture plan.**
- **In-game shots are device captures,** taken only through the existing device-round process
  (`.claude/skills/bedrock-device-round.md`: build from a commit, sim gates, brief, a Sonnet adb subagent, record).
  This planner touches no phone, and the Minecraft client on this PC is the user's. The storyboard JSON gives each
  shot's pack sha256, wand size, position, camera mode and duration, so the round's brief can be generated from it.
  `screenrecord` on the device is limited to 180 s per clip.
- **Before any phone round,** the same shot list is rendered offline (`_cockpit_view.ts` for the cockpit,
  `media-turntable.ts` for the rest) as an animatic, to check the framing.

---

## 7. Telemetry of success

| Question | Metric | Source | Access |
|---|---|---|---|
| Are people downloading? | downloads per channel per week | CurseForge Core API `GET /v1/mods/{id}` `downloadCount` | API key from console.curseforge.com, **granted by the user** |
| | | itch `GET https://itch.io/api/1/<key>/my-games` (`downloads_count`, `views_count`) | API key, **granted** |
| | | craftmatic.click `/get/*` counter (Analytics Engine SQL API) | Cloudflare API token, **granted** |
| | | GitHub release `download_count`, if Releases are used | public |
| | | MCPEDL page counts | manual entry (`output/biz-weekly/manual.json`); no scraping without approval |
| Do they come back for updates? | downloads of version N+1 ÷ N, within 14 days | the same | — |
| Do they support us? | Ko-fi supporters and amount; Patreon patrons; CurseForge points | Ko-fi webhook into a Worker KV log; Patreon API v2 `campaigns?fields=patron_count`; CF points entered by hand (no API) | webhook secret and creator token, **granted** |
| Do free users convert to paid packs (A)? | `/go/marketplace/*` click-outs; affiliate clicks and sales; publisher-reported units | Worker counter; impact.com reports; publisher statements, entered by hand | **granted** |
| Do free users convert to the converter (B)? | `/go/converter` click-outs; B sign-ups carrying `ref` | Worker counter; B's account record field `ref` (an interface contract with B: B stores the first-touch `ref` query parameter, nothing else) | ours |
| Is the site seen? | page views, referrers, countries | Cloudflare Web Analytics (cookieless) | beacon token, **granted** |

**Weekly report (D-15).** `bun scripts/biz-weekly-report.ts [--week=2026-W46]` writes
`output/biz-weekly/<week>.md` and appends to `history.jsonl`.
- Each source is a small adapter with `read(credentials | null): Promise<WeeklyMetric[]>`.
- **A source with no credential reports `not granted`, never 0.** A failed request reports `unavailable`, with the
  HTTP status.
- Credentials come from environment variables or Windows Credential Manager (the `api-keys-management` skill), never
  from a committed file.
- The report states the unit beside every number: "downloads are files fetched, not people". It also reports week
  over week, and flags a swing above 2x for a look at the environment or bots before any reading. Both follow the
  global lessons on concentration and 2x swings.
- **Targets to compare against,** from the pricing report's day-90 targets [GTM §5]:
  - 10k-50k free downloads;
  - 10-60 Ko-fi supporters;
  - 200-1,000 Discord or list members;
  - 300-1,500 converter sign-ups.

---

## 8. Release cadence and sequencing with A and B

**What ships free, against what is sold.** `release/cadence.json` holds the matrix below. It is checked against A's
design registry by D-17.

| SKU | Tier | Content | Why |
|---|---|---|---|
| **Brick Sampler v1.0** | **free** | 1 drivable car (A's first original vehicle), a door kit (2 hinged doors and 1 opening window), a seat kit (chair, bench, sofa) | Shows the three engine verbs (drive, open, sit). Small enough for every device. |
| Brick Sampler v1.1 | free update | + 1 boat or hover craft (a second vehicle class) | A reason to come back, timed 1-2 weeks before A's Garage launch |
| Brick Sampler v1.2 | free update | + 1 **micro** landmark (display scale, not walkable), from A's landmark line | Teases A's "Brick Paris". Recommended over a full landmark, which is A's paid showcase (Q7). |
| Seasonal mini-drop | free update, same project | one themed prop set | Keeps one project, so the download count is not split. CurseForge ranks by project. |
| Brick Garage, Coaster Park, Arcade: Pinball, Furniture & Doors, landmark worlds | paid (A) | — | Free content must never be a subset that makes a paid SKU redundant. The sampler's car and furniture are NOT in the paid Garage or Furniture packs (rule checked by D-17). |

**Sequencing.** "Day" counts from the user's go-ahead on A+D, following the pricing report's 90-day plan [GTM §5].
1. **Days 0-25: build.** A builds its compliance packages and its first designs. D runs waves 0-2 (§10) in
   parallel, on fixture packs.
2. **Day ~25: release candidate.** D-18 builds the sampler RC from A's first designs, and a device round plays that
   exact sha256.
3. **Day ~30: approvals and launch.**
   - Approvals: the tag, R2, the Worker, the site, CurseForge and MCPEDL, itch, Ko-fi.
   - The free launch.
   - A pitches publishers using the trailer and the first download numbers [GTM §5].
4. **Days 30-60.** Weekly reports. Sampler v1.1 goes out about 2 weeks before A's first paid pack is submitted.
5. **Day ~75.** B's converter beta. The sampler page's "make your own" block switches on (`site-config.converter`).
   v1.2 adds the micro landmark.
6. **Afterwards.** Every A launch gets one free sampler update 1-2 weeks before it, and the affiliate link goes on the
   detail pages.

**Update policy** (cooperative guidelines [CLS §1.2]):
- same uuids and namespace forever;
- never remove a shipped entity, block or item id (the identity ledger enforces this);
- bug fixes never break existing worlds;
- test against each new Minecraft release within 2 weeks, as a patch release if needed.

---

## 9. Work packages

**Every WP:**
- runs in its own worktree, `.worktrees/biz-d<NN>-<slug>`, on branch `biz/d<NN>-<slug>`;
- follows the binding brief (§0): fail-first TDD with vitest through `bun run test`, a single file with
  `bunx vitest run <file>`, `bun run typecheck` and `bun run typecheck:web` green, and conventional commits ending
  "— Opus 5.5" that cite the BIZ id;
- adds its guard test to its REQUIREMENTS row;
- never does a recursive delete, never touches a phone, and never takes an outward action.

### D-01: Product registry, semantic versions, frozen identity ledger (BIZ-52)
- **Goal:** a product's identity is minted once and never changes. Versions are semantic and must rise. No shipped
  id is ever dropped.
- **Files:**
  - `web/src/release/{types,semver,product,identity-ledger}.ts`;
  - `release/products/sampler.json` with `namespace: null` and real uuids minted by `init-product`;
  - `release/identity-ledger.json` (empty array);
  - `scripts/release.ts` (`init-product` subcommand only).
- **First failing test:** `test/release-identity.test.ts :: the same product at 1.0.0 and 1.1.0 keeps every uuid`.
  Then:
  - `:: a version that does not rise is refused`;
  - `:: dropping an entity id a released version shipped is refused`;
  - `:: a null namespace refuses a release build`;
  - `:: dev identity uuids differ from release uuids`;
  - `:: semver maps to the manifest triple`.
- **Acceptance:**
  - the tests above pass;
  - `init-product` refuses to overwrite an existing product;
  - the uuids are random v4, not derived from the label (so renaming the display name keeps them).
- **Depends on:** none.

### D-02: Engine release seam (BIZ-51, BIZ-52)
- **Goal:** `buildPlayableAddon(grid, {…, release})` emits a release pack:
  - registry uuids and namespace, and the semver version;
  - the clock from the context;
  - release texts in the name, descriptions, README and lang (no stamp, no LEGO words);
  - no `craftmatic-diagnostics.json`;
  - sanitised provenance (product, version, commit, design ids);
  - injected deflate.
- **Files:** `web/src/engine/playable-addon.ts` (around `:2608-2629`, `:4099`), `pipeline-version.ts` (clock),
  `mcpack.ts` (only if needed).
- **First failing test:** `test/playable-addon-release.test.ts :: a release build uses the registry uuids and the semver version`.
  Then:
  - `:: two release builds at different wall clocks are byte-identical`;
  - `:: a release pack carries no craftmatic-diagnostics.json and no pipeline stamp in any name`;
  - `:: without a release context the dev pack is unchanged` (an existing-behaviour guard).
- **Acceptance:** all pass; existing `playable-addon` tests stay green.
- **Depends on:** D-01, D-03, and A:namespace. **This WP is serial with A's namespace, folder and vanilla-texture
  WPs**, because all of them edit `playable-addon.ts`. Land A's namespace first, then rebase onto it by merge.

### D-03: Deterministic zip (BIZ-51)
- **Goal:** the same input files give the same archive bytes in any runtime.
- **Files:** `web/src/engine/zip-utils.ts`, with a `CreateZipOptions.deflate` hook and entries sorted by name when
  `deterministic: true`.
- **First failing test:** `test/zip-deterministic.test.ts :: pako deflate yields identical archives regardless of CompressionStream`.
  It stubs `CompressionStream` to a different compressor and expects an equal sha256 with the hook set.
- **Acceptance:** the round trip passes through the existing reader (`test/threemf-export`); the default behaviour is
  unchanged.
- **Depends on:** none. pako is already a dependency (`vite.config.ts` manualChunks).

### D-04: Part-source ledger and licence gate (BIZ-55; shared with A item 10)
- **Goal:**
  - every placed part records the library file actually read, its `!LICENSE` line and its authors;
  - a release build fails if any part comes from Studio, the network mirror or an unlicensed file;
  - `CREDITS-LDRAW.txt` lists each author once, with the CC BY 4.0 notice and the statement "not endorsed by
    LDraw.org".
- **Files:** `web/src/engine/ldraw-geometry.ts` (record the path at `:192-200`), the `ldraw-entity-compiler.ts`
  report, `web/src/release/notices.ts`.
- **First failing test:** `test/release-licence.test.ts :: a part resolved from Studio's UnOfficial tree fails the licence gate`.
  Then:
  - `:: credits list every author of every used part exactly once`;
  - `:: official 3001.dat records "Licensed under CC BY 4.0" and author James Jessiman` (a real file from
    `ldraw_ref/official`, guarded with `existsSync`, and the read inside `it`: the bun:test lesson);
  - `:: credits never contain part descriptions`. LDraw descriptions say "Minifig …", which the lint would reject.
- **Acceptance:** the ledger is populated for a fixture build; the gate is wired into D-08.
- **Depends on:** none.

### D-05: Notices, release texts and the forbidden-terms lint (BIZ-55)
- **Goal:**
  - the exact disclaimer string, with publisher and contact, in the README, the description and every listing;
  - text templates for the sampler;
  - a lint over every string a player or a listing reader sees.
- **Lint terms:**
  - `lego`, `duplo`, `minifig(ure)?`, `technic`, `bionicle`, `ninjago`;
  - the set-number shapes `\b\d{4,6}(-\d)?\b` in names;
  - licensed-theme words: Harry Potter, Hogwarts, Star Wars, X-wing, Marvel, Batman, Disney, Pixar, and car brands;
  - the genre-reference names that must not appear: Space Mountain, Seven Dwarfs, Speed Racer, Six Flags;
  - "Minecraft" anywhere except a secondary or disclaimer position;
  - `craftmatic:` ids in a release pack.
  
  Exemptions are explicit, one per entry with a reason (the disclaimer line itself).
- **Files:** `web/src/release/{notices,forbidden-terms}.ts`, `release/copy/sampler/{readme.txt,lang.json,…}`.
- **First failing test:** `test/release-lint.test.ts :: the lint flags "minifig" in a README`. Then:
  - `:: a set number in a pack name is flagged`;
  - `:: every release archive text carries the exact disclaimer`;
  - `:: the dev README at playable-addon.ts:4099 fails the lint` (this proves the lint would catch today's text).
- **Acceptance:** the sampler copy passes; a fixture of today's dev pack fails, with named hits.
- **Depends on:** D-04 (the credits format).

### D-06: Changelog (BIZ-53)
- **Goal:**
  - a curated `release/changelogs/<product>.md` in Keep-a-Changelog form is the source of truth;
  - `changelog.ts` checks that every version in the registry has a section, and suggests entries from
    conventional commits since the previous tag that touch the product's paths;
  - it renders the in-pack `CHANGELOG.txt`, the CurseForge per-file changelog, the itch devlog and the site HTML.
- **Files:** `web/src/release/changelog.ts`, `release/changelogs/sampler.md`.
- **First failing test:** `test/release-changelog.test.ts :: a release whose version has no curated section is refused`.
  Then:
  - `:: suggestions for 1.1.0 include only commits after sampler-v1.0.0`;
  - `:: the CurseForge rendering contains no Markdown the editor rejects`. The editor's subset is to be read at
    approval time, so start with plain lists.
- **Acceptance:** renderings are lint-clean (D-05).
- **Depends on:** D-01.

### D-07: Release validators (BIZ-54)
- **Goal:** one gate that answers "would Mojang's validator, CurseForge and MCPEDL accept this?".
- **`scripts/_mcaddon_check.py --release`, extended in place.** It checks:
  - `pack_scope: "world"`;
  - the RP→BP dependency;
  - one namespace, not `craftmatic`, across entities, blocks, items, geometry, animation and render-controller ids;
  - `<type>/<creator>/<pack>/` folders, with no loose files;
  - no vanilla-path textures (`textures/blocks/concrete_*`);
  - permutations of 10,000 or fewer;
  - size of 25 MB or less and 3,500 files or fewer;
  - texture sizes: 256 or less for blocks and items, 2048 or less otherwise;
  - no `-beta` script modules;
  - no `minecraft:` definitions;
  - no diagnostics file.
- **`scripts/release-mctools.ts`.** It runs `bunx @minecraft/creator-tools@0.21.0 validate -i <unzipped>` (Node 22+)
  and parses the output to the `mctools` part of ValidationReport. If `mct eula` has not been accepted, it stops and
  says so. Accepting the EULA is the user's decision (Q9).
- **CurseForge and MCPEDL packaging rules:** a `.zip` with no root folder, no `.exe`, no external download links in
  the copy.
- **First failing test:** `test/mcaddon-check-release.test.ts :: a pack without pack_scope world fails --release`. It
  spawns `python -I scripts/_mcaddon_check.py --release <fixture>`. Then:
  - `:: 10,001 permutations fail --release while 65,536 still passes the dev mode`;
  - `:: a craftmatic: id fails --release`;
  - `:: the mct report parser counts Errors` (on a recorded output fixture).
- **Acceptance:** today's 10261 pack fails `--release` with every blocker in [CLS §3] T4-T9 named. A fixture built
  to the rules passes.
- **Depends on:** none to build. Real packs pass only after A's compliance WPs.

### D-08: The one-command release script (BIZ-51, BIZ-56)
- **Goal:** `bun scripts/release.ts prepare|finalize|verify|status <product>` implements §3.3. It writes the bundle,
  `SHA256SUMS`, `release.json`, `validation.json` and `APPROVAL.md`.
- **Files:** `scripts/release.ts`, `web/src/release/checksums.ts`.
- **First failing test:** `test/release-script.test.ts :: prepare refuses a dirty tree`. Then:
  - `:: SHA256SUMS verifies with sha256sum -c`;
  - `:: finalize refuses a tag whose rebuild differs by one byte`;
  - `:: APPROVAL.md lists every outward action unchecked`;
  - `:: release sources contain no upload calls`. This is a static scan of `web/src/release/**` and
    `scripts/release*.ts` for `fetch(`, `butler`, `wrangler`, `api.curseforge`, `itch.io/api` and
    `git push|git tag`.
- **Acceptance:** an end-to-end run on a fixture product with a tiny original test model (committed, not LEGO)
  produces a complete bundle twice, with identical sha256.
- **Depends on:** D-01 to D-07, D-09, D-11 and D-12's catalog schema. The script can land earlier, with stages
  feature-flagged off until their WP merges.

### D-09: Channel bundle generators (BIZ-57, BIZ-58, BIZ-59)
- **Goal:** from the ProductRecord, the copy and the media, produce `channels/<channel>/` for CurseForge, MCPEDL,
  itch, Ko-fi, Patreon, the affiliate programme and the site. Each gets `fields.json`, the description, sized images
  and `CHECKLIST.md`, exactly as in §4.
- **Files:** `web/src/release/channels/*.ts`, `release/channels/*.json` (ChannelSpec: fields, length limits marked
  `verified`/`unverified`, image presets).
- **First failing test:** `test/release-channels.test.ts :: the curseforge logo is a square PNG of at least 400 px, under 2000 px and 4 MB`.
  Then:
  - `:: the itch cover is exactly 630x500`;
  - `:: every checklist item starts unchecked and names the user as approver`;
  - `:: no listing carries an ad-gated or shortener link`;
  - `:: donation links come last in the CurseForge description`.
- **Acceptance:** the bundle for the fixture product is complete. Every `unverified` limit is listed at the top of
  `APPROVAL.md`, to read off the form.
- **Depends on:** D-05, D-06, D-11 (fixtures are enough to start).

### D-10: Listing and site copy (BIZ-57, BIZ-58, BIZ-59, BIZ-60)
- **Goal:** final, lint-clean copy for every channel:
  - descriptions;
  - the install guide per platform;
  - controls (touch, keyboard, controller);
  - FAQ: "Does it change my world?" ("only into air, undo is in the wand"); "Consoles?"; "Is it LEGO?" ("No, our own
    designs, generic brick look");
  - Ko-fi and Patreon text;
  - the affiliate application;
  - the Discord server template.
- **Files:** `release/copy/sampler/*.md`, `release/copy/common/*.md`.
- **First failing test:** `test/release-copy.test.ts :: every copy file passes the forbidden-terms lint and its channel's length limits`.
- **Acceptance:** the user reads the copy in the RC bundle (a review, not an outward step).
- **Depends on:** D-05 (the lint), D-09 (the limits).

### D-11: Media renderer and thumbnails (BIZ-62)
- **Goal:** `scripts/media-turntable.ts` as described in §6:
  - game-frame mirroring, supersampling, auto-framing, ground and backdrop;
  - ffmpeg encodes to WebM, MP4 and GIF, plus posters;
  - every preset in `media-presets.ts`.
- **Files:**
  - `web/src/release/media-presets.ts`;
  - `scripts/media-turntable.ts`;
  - a shared framing module extracted from `scripts/_pack_render.ts`, edited in place, with no copy.
- **First failing test:** `test/release-media.test.ts :: a game-frame render of an asymmetric fixture puts the marker on the side the device shows`.
  The fixture is a one-cube pack with a marker at +X, and its expected side comes from the
  `block-collision-x-mirrored` and `worldFaces` conventions in CLAUDE.md. Then:
  - `:: every preset output is under 2000 px each side and under 4 MB`;
  - `:: the GIF preset falls back to fewer frames rather than exceed 4 MB`.
- **Acceptance:**
  - a 72-frame turntable of `60221-diving-yacht.mcaddon` (a dev-only check) renders in under 60 s;
  - the output is looked at, not just counted;
  - pictures are sampled for coverage (the model fills 55-75 % of the frame width).
- **Depends on:** none.

### D-12: craftmatic.click packs pages (BIZ-60)
- **Goal:** §5. That is:
  - the `/packs/`, `/packs/<id>/`, `/downloads/` and `/privacy/` pages;
  - `catalog.json` built from ReleaseRecords;
  - Vite multi-page;
  - the service-worker exclusions;
  - dark, mobile-first, accessible.
- **Files:** `web/packs/index.html`, `web/src/site/{packs,detail,downloads,privacy,site-config}.ts`,
  `web/src/release/catalog.ts`, `web/vite.config.ts`, `web/public/sw.js`.
- **First failing test:** `test/site-catalog.test.ts :: every catalog download has a sha256 and a /get/ href`. Then:
  - `:: a null newsletter config renders no form`;
  - `:: sw.js does not cache /get/ or .mcaddon`.
- **Browser gate.** A Node Playwright probe (`scripts/_site_probe.mjs`; the project rule is Node for CDP) checks at
  360x780, 390x844 and 1440x900:
  - no horizontal scroll;
  - touch targets of at least 44 px;
  - the video poster shows.
  
  Screenshots must be under 2000 px and are looked at.
- **Acceptance:** `bun run build:web` emits the pages, and `bun run typecheck:web` is clean. **Deploying is outward**
  (ApprovalItem `site.deploy`).
- **Depends on:** D-01 (the schema), D-11 (media). It can start on fixture media.

### D-13: Worker counters and the R2 release bucket (BIZ-61, BIZ-63)
- **Goal:**
  - `worker/downloads.ts` (TypeScript), mounted from `worker/ldraw-omr.js`;
  - `GET /get/<product>/<version>/<file>?ref=` checks the catalog allow-list, writes one Analytics Engine data point
    (blobs: product, version, file kind, ref, `request.cf.country`; double: 1), and streams from the R2 bucket
    `RELEASES` with `Content-Disposition`;
  - `GET /go/<target>?ref=` counts the click and redirects with 302 to the configured URL;
  - no IP, user agent or cookie is stored;
  - `wrangler.toml` gains the `RELEASES` R2 binding, the `DOWNLOADS` Analytics Engine dataset and routes for `/get/*`
    and `/go/*`.
- **Files:** `worker/downloads.ts`, `worker/ldraw-omr.js` (the mount), `wrangler.toml`.
- **First failing test:** `test/worker-downloads.test.ts :: an unknown product 404s and records nothing`. Then:
  - `:: a counted download writes no IP or user agent` (with a fake AE binding);
  - `:: /go/ to a target not in the config is refused` (no open redirect).
- **Acceptance:** the tests pass under vitest. `bunx wrangler deploy` and creating the bucket are **outward**
  (ApprovalItems `worker.deploy` and `r2.create`).
- **Depends on:** D-01. Coordinate with B, which also adds Worker routes for accounts and payments: one shared router,
  merged in sequence.

### D-14: Funnel blocks: newsletter, Discord, donations (BIZ-61)
- **Goal:** the config-gated components of §5, the `/privacy/` text, and the Discord template
  (`release/copy/common/discord-template.md`).
- **Files:** `web/src/site/{funnel,site-config}.ts`.
- **First failing test:** `test/site-funnel.test.ts :: with every funnel config null the page has no newsletter, discord or donation element`.
  Then:
  - `:: the newsletter form states the age wording and double opt-in`;
  - `:: donation links never sit on or near a download button`. The aim is to keep the two visually separate, so a
    tip is never read as a fee.
- **Acceptance:** the Playwright probe passes. Providers are filled in only after Q5 and Q6.
- **Depends on:** D-12.

### D-15: Weekly report (BIZ-63)
- **Goal:** `scripts/biz-weekly-report.ts`, as in §7, with adapters `{github, curseforge, itch, cfAnalytics,
  workerCounters, kofi, patreon, manual}`. It is GET-only, with credentials from the environment or Credential
  Manager.
- **Files:** `scripts/biz-weekly-report.ts`, `web/src/release/telemetry/*.ts` (pure parsers).
- **First failing test:** `test/biz-weekly-report.test.ts :: a source with no credential reports "not granted", never zero`.
  Then:
  - `:: a 2x week-over-week swing is flagged`;
  - `:: the CurseForge parser reads downloadCount from a recorded response fixture`;
  - `:: the report prints the unit beside every number`.
- **Acceptance:** a run with no credentials writes a complete report of `not granted` rows. A run with only public
  sources fills those rows.
- **Depends on:** D-13 (the AE schema).

### D-16: Trailer storyboard and capture plan (BIZ-62)
- **Goal:** `release/media/sampler.storyboard.json` and its schema. A generator turns it into:
  1. an offline animatic (D-11 renders plus `_cockpit_view.ts`);
  2. the shot section of a device-round brief, handed to the device-round process. No phone is used here.
- **Files:** `web/src/release/storyboard.ts`, `release/media/sampler.storyboard.json`.
- **First failing test:** `test/release-storyboard.test.ts :: a storyboard longer than 45 s or a shot without a pack sha256 is refused`.
- **Acceptance:** the animatic MP4 exists for the fixture product, and the brief section reads cleanly.
- **Depends on:** D-11 for the animatic only.

### D-17: Cadence and the SKU matrix (BIZ-64, BIZ-50)
- **Goal:** `release/cadence.json` holds the §8 matrix and calendar. A checker verifies that:
  - every free SKU's designs exist in A's design registry, with provenance logs;
  - no free design is also in a paid SKU;
  - every scheduled update precedes the A launch it supports.
- **Files:** `web/src/release/cadence.ts`, `release/cadence.json`.
- **First failing test:** `test/release-cadence.test.ts :: a free SKU that names a design inside a paid SKU is refused`.
  Then:
  - `:: a free SKU naming a design with no provenance log is refused`.
- **Acceptance:** green against A's registry once it exists, and against a fixture registry until then.
- **Depends on:** A:design-registry (and its provenance-log schema).

### D-18: Sampler v1.0.0 release candidate, end to end (BIZ-50)
- **Goal:**
  - fill `release/products/sampler.json` with A's first car, door kit and seat kit, and the decided namespace and
    publisher (Q1, Q8);
  - run `release.ts prepare sampler`;
  - get every gate green;
  - hand the bundle to a device round (via the process, not this agent), record `deviceEvidence`, and give the user
    `APPROVAL.md`.
- **First failing test:** `test/release-sampler.test.ts :: the sampler product validates and names only designs with provenance logs`.
  This is red until A's designs land.
- **Acceptance:** the bundle passes `verify`. The device round finds no content-log errors on load, placement, drive,
  open or sit. The user has the bundle path, the sha256 and `APPROVAL.md`.
- **Depends on:** everything above, plus A:namespace, A:folders, A:vanilla-textures, A:figure (if the sampler shows
  figures; v1.0 has none), A:placement-undo, A:first-designs.

---

## 10. Parallelisation order

| Wave | WPs (one subagent each) | Can start when | Conflict notes |
|---|---|---|---|
| 0 | D-01, D-03, D-04, D-07, D-11, D-16 | now | D-04 touches `ldraw-geometry.ts`: check no A or B WP is editing it. D-07 edits `_mcaddon_check.py` in place. |
| 1 | D-02, D-05, D-06, D-13, D-10 (draft) | D-01 and D-03 (D-02 also needs A:namespace merged); D-04 for D-05; D-01 for D-06 and D-13 | **D-02 is serial with A's `playable-addon.ts` WPs.** D-13 shares the Worker router with B: merge in sequence. |
| 2 | D-08, D-09, D-12, D-15 | wave 1 | D-12 edits `web/vite.config.ts`, as B's converter pages may: merge in sequence. |
| 3 | D-14, D-17, D-10 (final) | D-12; A:design-registry | — |
| 4 | D-18 | all of D, plus A's compliance and first designs | then the device round (process), then user approvals |

Up to 6 agents in wave 0 and 5 in wave 1. Each merges after review, with merge commits and no rebase. Build any pack
only from a committed tree.

---

## 11. REQUIREMENTS.md rows to add (section 17)

Paste these verbatim. All are `OPEN`, and the guards are filled as the WPs land.

```md
| `BIZ-50` | Free sampler pack of OUR OWN designs (one drivable car + a door kit + a seat kit; a micro landmark later) released free as the funnel for A and B (the user 2026-11-09, scenario D) | OPEN | plan `docs/plans/business-D-free-releases.md` §8, WPs D-17, D-18 | none | — | needs A's first original designs and compliance WPs; namespace/brand undecided (Q1) |
| `BIZ-51` | Reproducible release builds from a tagged commit: rebuilding the tag yields a byte-identical .mcaddon (offline, pinned LDraw library, pinned toolchain, SOURCE_DATE_EPOCH, deterministic zip) | OPEN | plan §3.3, WPs D-02, D-03, D-08 | none | — | today's builds embed the build instant (`pipeline-version.ts:219`) and runtime deflate (`zip-utils.ts:89`) |
| `BIZ-52` | Semantic pack versions with uuids and namespace frozen per product across all versions; an identity ledger refuses a non-rising version or a dropped entity/block/item id; dev builds never collide with releases | OPEN | plan §3.2, WP D-01 | none | — | uuids follow the label today (`mcpack.ts:170`) |
| `BIZ-53` | A curated changelog per product, rendered into the pack, CurseForge file notes, itch devlog and the site | OPEN | WP D-06 | none | — | none exists |
| `BIZ-54` | Release packaging passes Mojang's validator (MCTools `mct validate` 0 Errors), `_mcaddon_check.py --release` (pack_scope, RP->BP dependency, namespace, folders, no vanilla overrides, <=10,000 permutations, <=25 MB / 3,500 files) and CurseForge/MCPEDL packaging rules | OPEN | WP D-07 | none | — | the gate caps permutations at 65,536 (`_mcaddon_check.py:267`); today's packs fail T4-T9 of the BIZ-04 report |
| `BIZ-55` | Every release carries the Mojang disclaimer, publisher + contact, and generated LDraw CC BY 4.0 credits; no Studio-only mesh; a forbidden-terms lint keeps LEGO marks, set numbers, minifig and licensed/ride-brand names out of every player-facing and listing string | OPEN | WPs D-04, D-05 | none | — | CLI builds read Studio's library (`_playable_ref.ts:39`); dev README/RP text names LEGO (`playable-addon.ts:2626`, `:4099`) |
| `BIZ-56` | sha256 sums for every artifact and ONE command (`bun scripts/release.ts prepare <product>`) that prepares upload bundles and an approval sheet, with no upload code; finalize/verify prove the tag rebuild matches | OPEN | WP D-08 | none | — | — |
| `BIZ-57` | CurseForge + MCPEDL listing prepared (fields, categories, logo/screenshots/MCPEDL thumbnail within limits, description, changelog, rewards), awaiting the user's approval | OPEN | plan §4.1, WPs D-09, D-10 | none | — | summary length limit and MCPEDL thumbnail size unverified |
| `BIZ-58` | itch.io free-download page prepared (fields, 630x500 cover, screenshots, tags, butler command), awaiting approval | OPEN | plan §4.2, WPs D-09, D-10 | none | — | pricing mode (no payments vs $0-or-donate) is Q4 |
| `BIZ-59` | Ko-fi tips, a Patreon dev log with NO paywalled packs, CurseForge rewards and the Minecraft affiliate link prepared (copy, images, checklists), awaiting approval | OPEN | plan §4.3-4.5, WPs D-09, D-10 | none | — | accounts are the user's |
| `BIZ-60` | craftmatic.click packs gallery, pack detail pages and downloads list with screenshots, turntable videos, install guide, checksums, credits and donation links; dark, mobile-friendly, touch-sized | OPEN | plan §5, WP D-12 | none | — | Vite builds only index.html today (`web/vite.config.ts:51`) |
| `BIZ-61` | Newsletter/Discord funnel prepared (config-gated, nothing live until approved) and privacy-first analytics: cookieless page analytics plus Worker download/click-out counters storing no IP, user agent or cookie; a /privacy/ page | OPEN | plan §5, WPs D-13, D-14 | none | — | providers undecided (Q5, Q6) |
| `BIZ-62` | Media production: automated offline renders and turntables (game-frame, supersampled) and platform thumbnails under 2000 px / 4 MB; a trailer storyboard and a device capture plan handed to the device-round process | OPEN | plan §6, WPs D-11, D-16 | none | — | `_pack_render.ts` may draw the mirror image (`:24-26`) |
| `BIZ-63` | Telemetry: downloads per channel, update uptake, supporters, conversion to paid packs (A) and to the converter (B), in a weekly report that reads only public counters or ones the user grants and reports "not granted", never zero | OPEN | plan §7, WPs D-13, D-15 | none | — | no counters today (`/downloads/*` is uncounted GitHub Pages) |
| `BIZ-64` | Release cadence: which content ships free vs paid, no free design inside a paid SKU, and a calendar sequencing sampler updates before each A launch and the B beta | OPEN | plan §8, WP D-17 | none | — | depends on A's design registry and calendar |
```

---

## 12. Risks

| # | Risk | Effect | Mitigation |
|---|---|---|---|
| R1 | **The namespace and uuids are irreversible** once a public build exists ("the only thing that can't easily be updated post-release" [CLS §1.3]). | A bad choice is permanent across CurseForge, itch and the Marketplace. | `namespace: null` refuses any release (D-01). The user decides Q1 before D-18. |
| R2 | **Public repo.** `tribixbite/craftmatic` is public, so A's design sources, the release registry and this plan are readable by anyone. The paid designs could be rebuilt from the repo. | A's revenue; a strategy leak. | Q10: keep design sources (and possibly `release/`) in a private repo, and have the public repo consume them by path. Decide before A commits designs. |
| R3 | **A LEGO-named download is live** (`/downloads/Craftmatic-Lego-Pack.mcpack`, linked from `lego.ts:2182-2195`), and the LEGO tab itself converts official sets on the same domain the free packs will promote. | It undercuts the "original designs only" posture the funnel depends on, and is a takedown target [BIZ-01 verdict]. | Q11: the user decides whether to rename, unlink or keep it. D's pages must not link to the LEGO tab. |
| R4 | **Studio-only meshes** reach a release through the alias ladder. | A breach of Studio's EULA. | The D-04 licence gate. Release builds read only the official LDraw library, offline. |
| R5 | **A non-reproducible build** (CompressionStream, clocks, the network mirror). | `verify` fails; the published bytes cannot be proven. | D-02 and D-03, offline builds, the toolchain pinned in the ProductRecord. |
| R6 | **Marketing renders are mirror images** of the game (`_pack_render.ts:24-26`). | Wrong-handed images, mirrored text on signs, and confused players. | The D-11 `--game-frame` test against the measured convention. A device shot is the arbiter. |
| R7 | **Unmeasured platform limits:** CurseForge summary length, Markdown support and `.mcaddon` acceptance; MCPEDL thumbnail size; itch tag limit; Patreon and Ko-fi banner sizes. | A rejected upload, or a re-crop at upload time. | Limits are marked `unverified` in ChannelSpec and listed at the top of `APPROVAL.md`. Several image sizes are pre-rendered. |
| R8 | **Children are the audience:** a newsletter, Discord (13+), analytics. | Privacy-law exposure (COPPA, GDPR-K). | No personal data by default; cookieless analytics; everything config-gated; Q5 and Q6 go to the user and the lawyer. |
| R9 | **Tiny income:** est. $5-50 a month in CurseForge rewards and $20-200 in tips [GTM §4 D]. | Effort that does not pay. | D's purpose is audience proof for A's publisher pitch and B's funnel. Judge it on downloads and conversion (§7), not on tips. |
| R10 | **Cannibalisation:** free content makes a paid pack redundant. | Lower A sales. | The D-17 rule: no free design inside a paid SKU. The sampler is deliberately small. |
| R11 | **A Minecraft update breaks the pack** ("works release after release" [CLS §1.3]). | Bad ratings and support load. | Stable script modules only (D-07); a patch within 2 weeks of each Minecraft release; the update policy in §8. |
| R12 | **Device QA is outside this planner.** The release depends on a device round that plays the exact sha256. | A release blocked on phone availability. | `deviceEvidence` is required only at `finalize`. Offline sim gates run first. |
| R13 | **The service worker** caches multi-MB downloads (`sw.js:49-66`), and **Cloudflare** holds static assets 4 h. | Stale files and storage bloat. | D-12's service-worker exclusions; versioned file names. |
| R14 | **`mct eula`** needs the Minecraft EULA accepted on this machine. | The validator gate blocks. | Q9: the user accepts it once, or runs the validator themselves. |
| R15 | **Several agents edit the same files** (`playable-addon.ts`, `vite.config.ts`, the Worker). | Merge conflicts, or lost work. | The serial merge order in §10. |

## 13. Open questions for the user

1. **Brand, creator name and namespace prefix** (`<creator>_<pack>`). They are irreversible (R1), and shared with A.
2. **The pack's licence** on CurseForge and itch: All Rights Reserved (proposed), or a Creative Commons licence. This
   goes to the lawyer too.
3. **Where release files live:** an R2 bucket through the Worker (recommended, so downloads are counted), plus GitHub
   Releases as a public mirror or not.
4. **itch pricing:** "No payments" (recommended) or "$0 or donate".
5. **Newsletter provider and Discord:** now or later, and the age policy (lawyer).
6. **May the site load the Cloudflare Web Analytics beacon** (cookieless)?
7. **Sampler content:** car, doors and seats only, or also a landmark in v1.0? Recommended: a micro landmark in
   v1.2, not v1.0.
8. **The publisher name and contact email** shown on every listing; the usage guidelines require a non-chat contact.
9. **Accepting the Minecraft EULA for `mct`** on this PC, or running `mct validate` yourself.
10. **Private repository** for A's design sources and the release registry (R2)?
11. **The live `Craftmatic-Lego-Pack.mcpack` download, and the LEGO tab's place on craftmatic.click** (R3).
12. **Which telemetry credentials you will grant:** a CurseForge API key, an itch API key, a Cloudflare token, a
    Patreon token, a Ko-fi webhook.
13. **Patreon at launch,** or Ko-fi only at first (one account fewer)?

---

## 14. Tracker: section to add to `TASKS-BUSINESS.md`

```md
## Scenario D: free releases (BIZ-50..64)
Plan: `docs/plans/business-D-free-releases.md`. Open work only; history in `git log`.

### Start here
- STATE: plan written 2026-11-09, awaiting the Fable merge with the A and B plans. No WP started.
- Blocking decisions (plan §13): Q1 namespace/brand, Q8 publisher + contact, Q10 private repo; before D-18 also Q2,
  Q3, Q4.
- Binding: no upload, sign-up, tag, push, Worker deploy, R2 publish or post without the user's per-instance approval;
  phones only through the device-round process; no recursive deletes.

### Work packages (one subagent each, worktree `.worktrees/biz-d<NN>-<slug>`)
| WP | BIZ | Wave | Status | Branch | Guard test |
|---|---|---|---|---|---|
| D-01 registry + semver + identity ledger | 52 | 0 | open | | test/release-identity.test.ts |
| D-02 engine release seam | 51,52 | 1 (after A:namespace) | open | | test/playable-addon-release.test.ts |
| D-03 deterministic zip | 51 | 0 | open | | test/zip-deterministic.test.ts |
| D-04 part-source ledger + licence gate | 55 | 0 | open | | test/release-licence.test.ts |
| D-05 notices + forbidden-terms lint | 55 | 1 | open | | test/release-lint.test.ts |
| D-06 changelog | 53 | 1 | open | | test/release-changelog.test.ts |
| D-07 release validators (+ mct) | 54 | 0 | open | | test/mcaddon-check-release.test.ts |
| D-08 release.ts prepare/finalize/verify | 51,56 | 2 | open | | test/release-script.test.ts |
| D-09 channel bundles | 57,58,59 | 2 | open | | test/release-channels.test.ts |
| D-10 listing + site copy | 57-60 | 1-3 | open | | test/release-copy.test.ts |
| D-11 media turntables + presets | 62 | 0 | open | | test/release-media.test.ts |
| D-12 packs pages + catalog | 60 | 2 | open | | test/site-catalog.test.ts |
| D-13 Worker counters + R2 config | 61,63 | 1 | open | | test/worker-downloads.test.ts |
| D-14 funnel blocks | 61 | 3 | open | | test/site-funnel.test.ts |
| D-15 weekly report | 63 | 2 | open | | test/biz-weekly-report.test.ts |
| D-16 storyboard + capture plan | 62 | 0 | open | | test/release-storyboard.test.ts |
| D-17 cadence + SKU matrix | 64,50 | 3 | open | | test/release-cadence.test.ts |
| D-18 sampler v1.0.0 RC end to end | 50 | 4 | open | | test/release-sampler.test.ts |

### Commands (once built)
- `bun scripts/release.ts init-product <id>`: mint the frozen identity, once.
- `bun scripts/release.ts prepare <id>`: bundle in `output/releases/<id>/<ver>/`, gates, `APPROVAL.md`.
- `git tag -a <id>-v<ver> <commit>`: THE USER runs it; then `bun scripts/release.ts finalize <id>`.
- `bun scripts/release.ts verify <id> <ver>`: rebuild from the tag, compare sha256.
- `bun scripts/media-turntable.ts <pack> --preset=all --out=<dir>`.
- `bun scripts/biz-weekly-report.ts`: writes `output/biz-weekly/<week>.md`.

### Awaiting approval (outward steps, filled from each bundle's APPROVAL.md)
- (none yet)
```

---

## Appendix: measurement commands used for this plan

```sh
# timings and gate on an existing dev pack (not a release candidate)
bun scripts/_pack_render.ts output/device-round-2026-10-16zl/packs-feb168d9/60221-diving-yacht.mcaddon --out=<scratch>/yacht.png --views=8 --image=640x480   # 1.7 s
python scripts/_mcaddon_check.py output/device-round-2026-10-16zl/packs-feb168d9/60221-diving-yacht.mcaddon            # OK, 0.19 s
curl -sI https://craftmatic.click/ ; curl -sI https://craftmatic.click/downloads/HotSchem-Live-0.6.0.mcaddon
curl -s https://registry.npmjs.org/@minecraft/creator-tools      # latest 0.21.0, bin mct
gh repo view --json visibility                                    # PUBLIC
sha256sum C:/git/clego/ldraw_ref/_archives/complete.zip           # d2a695868ed2b395...
```
