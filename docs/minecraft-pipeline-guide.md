# Minecraft export pipeline

Read before changing schematic export, voxelization, resolution, block palettes, or native Bedrock structures. For playable vehicles, see [Bedrock add-ons](bedrock-addon-guide.md). Shared download naming and progress conventions are in [LEGO rendering](lego-renderer-guide.md).

[Project guide](../CLAUDE.md). Paths in code spans are relative to the repository root unless explicitly qualified.

- **Minecraft exports are proportion-exact + high-res** (2026-08-23): schem/
  litematic pick the finest UNIFORM cubic cell from [4,5,8,10,20] LDU fitting
  max(w,l)≤640, h≤320, ≤30M cells (cellLDU 4 = 5 cells/stud, 2/plate — 4
  divides both 20 and 8, so NO 2.5× vertical stretch), geometry-voxelized
  with a bbox fallback + fillSingleVoxelGaps (no keepLargestComponent —
  minifigs are real separate components). The build guide stays at 1
  cell/stud. GLB/OBJ/STL were verified axis-exact already (STL bbox matches
  studs×8mm per axis to the decimal).
- **Minecraft export runs in a Web Worker + the OOM cause (S3, 2026-09-01).**
  `web/src/engine/schem-worker.ts` runs voxelize → fillSingleVoxelGaps → NBT →
  gzip off the main thread and streams `{phase, pct}` to the banner;
  `runSchemExportWorker` (now in `ui/schem-export.ts`, see S4 below) falls back
  to the identical inline path if a Worker can't be constructed. **`vite.config.ts` must keep
  `worker: { format: 'es' }`** — the rollup default (`iife`) can't code-split,
  which the worker's graph needs. MEASURED before→after (21063 .io, cellLDU 4,
  7.47M-cell grid): voxelize 85.5 s → 5.9 s, peak RSS 935 → 490 MB; at the
  30M-cell cap the NBT encode alone was **1.33 GB RSS for a 0.2 MB file** →
  338 MB. Three causes, all fixed, all output-preserving:
  1. **`number[]` byte accumulation** (the OOM): `encodeBlockData` and both NBT
     writers pushed every output byte into a JS array (+783 MB / +325 MB at
     30M cells). Now `web/src/engine/byte-writer.ts` (growable Uint8Array) and
     an exact-size two-pass varint encoder. Encoders moved to
     `web/src/engine/schem-encode.ts` (no THREE/DOM, so the worker can import
     them); `exporter.ts` re-exports them.
  2. **object-per-cell accumulator** in `ldraw-geometry.ts` — 1.60M
     `{gx,gy,gz,block,color}` objects ≈ 98 MB; now chunked parallel
     Int32/Uint16 arrays (14 B/cell) with interned block strings.
  3. **O(rays × triangles) sweep** (the 85 s): each sweep now has a
     per-triangle bbox bucket index (CSR). Provably equivalent — Möller-
     Trumbore's u/v test already rejects rays outside the projected bbox, and
     `parityFill` sorts hits so visit order can't matter.
  **Byte-identity is the gate, and it passed**: `scripts/_schem_ref.ts` on
  21063 gives the same sha256 before and after (CLI/filesystem = deterministic).
  Do NOT compare browser exports for identity — the dev `/ldraw-parts` upstream
  fallback makes part resolution nondeterministic (two runs of the SAME code
  differed by 570 blocks). Profilers: `scripts/_schem_profile.ts` (full path),
  `scripts/_schem_encode_profile.ts` (encode at the 30M cap).
- **ONE shared Minecraft-export module for every tab (S4, 2026-09-01).**
  `web/src/ui/schem-export.ts` `runMinecraftExport()` is the ONLY path that
  encodes a .schem/.litematic/.mcpack for a user download; it owns resolution planning,
  the Worker (+ identical inline fallback via the same function), the progress
  banner, the build-guide hand-off and the download. Two sources:
  `{kind:'bricks'}` (LEGO tab → voxelize → fillSingleVoxelGaps → encode) and
  `{kind:'grid'}` (Upload tab / generator / gallery inline+overlay viewers →
  encode ONLY; an uploaded schematic is already blocks, re-voxelizing or
  gap-filling it would be lossy). The work itself lives in
  `web/src/engine/schem-pipeline.ts` (`runSchemPipeline`), which
  `schem-worker.ts` is now just message plumbing around. `main.ts`'s old
  `exportSchem/exportLitematic` dropdown calls are gone; those exporter.ts
  helpers remain only for the dev/batch surfaces (tiles batch, comparison).
  - **User settings** (`⚙ MC settings` popover, `ui/schem-settings-panel.ts`,
    persisted in `localStorage['craftmatic.mcExportSettings']`, read at export
    time so both tabs always agree): **Resolution** (Auto = the shipped ladder,
    or 1 / 2.5 / 5 / **10** blocks per stud; an over-cap explicit choice is
    coarsened back to the auto pick and the status names the cap that refused
    it — usually HEIGHT, not width, so `refusedBy` is reported rather than
    guessed. **10 blocks per stud (cellLDU 2) is opt-in only and deliberately
    NOT in `AUTO_CELL_LADDER`**: it is ~7× the cells of the 5×/stud tier
    (5969-1: 15,502 → 107,191 non-air, 98 → 186 ms, peak RSS 295 MB) and only
    small models clear the caps at all — 21063, 60380, 71043 and 76416 are all
    refused (`scripts/_res_survey.ts` prints the auto and 10×/stud plans for any
    model). Putting it in the ladder would silently inflate every small export), **Block mapping profile**
    (`engine/block-profiles.ts` — TWO real profiles since 2026-09-08:
    `default` (concrete & glass) and `textured` (see below). Don't add
    placeholder profiles; an entry must be a genuinely different table), and
    **Light enclosed interiors** (OFF by default). Pure planning lives in
    `engine/schem-settings.ts` (`planResolution`, `spanOfBricks`, `describePlan`).
    The dims preview and the caps both use the BRICK-ORIGIN span + 80 LDU pad —
    it understates a tiny model's real extent (unchanged pre-S4 behaviour).
  - **"Textured + shapes" profile** (`engine/textured-palette.ts`, 2026-09-08) —
    OKLab nearest-neighbour over a palette of the families that actually HAVE
    slabs and stairs (stone/deepslate/blackstone, sandstone, bricks/mud,
    prismarine, quartz, purpur, end stone, waxed cut copper, all 11 planks) plus
    the 16 dyed concretes as the fallback. **Selectable, NOT the default** — a
    palette change repaints every export, so it ships opt-in. Measured on 21063:
    shaped cells 5,367 → 57,702; on 60380 slabs 2,480 → 66,112; `nonAir`
    identical either way (it only recolours). Three gates, and the third was
    forced by a schemat.io A/B rather than reasoned up front:
    1. absolute OKLab distance ≤ 0.08. A margin-only rule is NOT enough — OKLab
       genuinely rates `acacia_planks` (0.103) closer to LEGO Red than
       `red_concrete` (0.123), because MC's red concrete is a dark maroon, so
       the first cut repainted red as wood, orange as bamboo, purple as crimson.
    2. no worse than the best dyed candidate by more than 0.02.
    3. **hue/chroma character.** The first A/B came back with 121,594 cells of
       21063's Olive Green landscaping as `bamboo_planks` — a yellow floor where
       the set has a lawn — and Dark Tan as neutral `polished_andesite`. A
       chromatic colour now needs a candidate within 20° of hue keeping ≥35% of
       its chroma; a neutral one may not GAIN chroma; and the matcher takes the
       nearest candidate that PASSES (which is what makes Dark Tan `oak_planks`,
       dh 7°, instead of andesite).
    A colour is **only ever replaced by a shape-capable block** — where the
    gates refuse everything the default table's hand-curated answer is kept
    verbatim, rather than substituting the nearest dyed block (that is how LEGO
    Orange briefly became `yellow_concrete`: nearer, and wrong). Black is the
    honest hole: vanilla's darkest slab material, `blackstone`, is a whole OKLab
    lightness step above LEGO black, so 16,688 cells stay cubes.
    `scripts/_textured_survey.ts` prints every LDraw colour with both distances,
    and `--probe=#RRGGBB` the per-axis deltas for one — tune from THAT, not from
    estimates. Tests: `test/textured-palette.test.ts` (anchors in both
    directions, including the three greens the guard saves).
  - **Light fill** (`engine/light-fill.ts`): flood air inward from the grid
    boundary → everything unreached is an enclosed pocket → pockets ≥ 8 cells
    get a light on their FLOOR, one per `spacing`³ (6) bucket (glowstone, or a
    `lantern` when Block shapes is on — see below). A room with a doorway is
    reachable from outside, so it stays dark by design. Runs after
    fillSingleVoxelGaps, only when the flag is on.
  - **The export REUSES the viewer's part geometry — zero network (S6,
    2026-09-02).** The export resolver (`engine/ldraw-geometry.ts`) keeps its
    own `.dat` text cache, a different module from the viewer's
    (`viewer/ldraw/parts.ts`) and, in the worker, a different THREAD — so
    exporting the model already on screen re-downloaded its whole part library.
    `schem-export.ts` now snapshots the viewer's cache (`collectDatTexts()` —
    library fetches + the IndexedDB warm cache + MPD inlines + archive
    `CustomParts/`, `null` = definitive miss) and ships it as
    `SchemWorkerInput.datTexts`; `runSchemPipeline` calls `seedDatTexts()`
    before voxelizing. Texts in, triangles out — the resolver is untouched, and
    anything absent from the seed still fetches (with progress). Measured in
    Chrome on 21063: **53 `/ldraw-parts` requests during load, 0 during
    export** (with 3D Render OFF, i.e. nothing pre-loaded: 866 during export,
    as designed). Bonus: `.io` CustomParts exist only in the archive and used to
    hit the AABB box fallback in the export — they now voxelize for real.
    Tests: `test/schem-seeded-geometry.test.ts`.
  - **Geometry resolution was TIMING-DEPENDENT until 2026-09-02 — don't
    reintroduce.** `resolvePartTriangles` publishes a part's triangle array into
    `partGeomCache` before its sub-file refs are appended (the cycle guard), and
    the cache was checked BEFORE `geomInFlight` — so a parent could bake in a
    half-assembled child, and which caller lost the race depended purely on
    fetch timing. The same model voxelized to 1,184,777 cells over the network
    and 1,174,763 over a warm cache, with 4,474 cells of real geometry lost even
    cold. In-flight is now checked first; only a genuine reference CYCLE (an
    explicit ancestor set threaded through the recursion) may read the partial
    array. `viewer/ldraw/parts.ts` has the same shape and papers over it with
    `invalidatePartGeom` — if you touch either resolver, keep the ordering.
  - **Inter-part contact pass ("floating minifig hair", 2026-09-08).**
    `bridgePartContacts` in `engine/ldraw-geometry.ts`, ON by default
    (`VoxelizeOptions.bridgeParts: false` reproduces the old output).
    ROOT CAUSE, measured with `scripts/_hair_probe.ts` on 76416-1: LDraw authors
    a hairpiece so its socket CLEARS the head stud — 62810's underside sits
    **1.81 LDU** above the head's crown, 25972's 0.26, 99930's −0.12. A 4-LDU
    cell cannot represent a gap that small, and the rounding drops the hair's
    shell one row ABOVE and one column OUTSIDE the head's top row (which holds
    only the stud), so the two footprints meet **diagonally** — min Chebyshev
    distance 1, no shared face. In Minecraft that reads as a hovering hat.
    Nothing closed it: `fillSingleVoxelGaps` fills X/Z runs flanked on BOTH
    sides and has **no vertical pass at all**, so a diagonal step is invisible
    to it. The pass is PAIRWISE (the first attempt — "part with no contact
    anywhere" — missed the hair entirely, because the hair IS voxel-connected to
    the neck bracket it clips into while still visibly floating over the head):
    a pair is eligible only when its real world-LDU AABBs are within **half a
    cell** (a gap of one cell or more is representable, so it is REAL — measured
    4.00 LDU between stacked plates on 76416-1 — and stays open), it is skipped
    the moment the two footprints share any face, and otherwise every partner
    cell in the interface window takes its own shortest monotone path (≤1 cell)
    to the other part, coloured as the upper part. Two minifigs a stud apart are
    20 LDU / 5 cells apart: no pair is ever formed. Measured: 76416-1 2,229 near
    pairs → 29 bridged, +236 cells (+0.15%); 71043 Hogwarts 29,299 → 363,
    +3,765 cells (+0.10%), voxelize 8.7 s → 10.8 s. Content diff on 21063 (via
    `scripts/_schem_diff.ts`, which re-imports both files through the real
    parser): **1,748 gained, 0 lost**, 173 recoloured (gap-fill copies a
    neighbour, and the neighbour changed). Tests: `test/part-bridge.test.ts`
    (synthetic head+hair: 2 components → 1; a 3-LDU gap left alone; two heads
    never fused; additive-only). **Evidence on the real parts**:
    `scripts/_minifig_slice.ts <model.io> [cell] [figIndex] --pair [--out pfx]`
    voxelizes a head and the piece sitting on it both ways and prints the two
    slices side by side — 76416-1 fig #2 at cellLDU 4 goes from a FULL air row
    between hair and head (2 components) to a closed seam (1 component, +37
    cells) — and `--out` writes both as `.schem` for an external view:
    `output/schem-backlog/hair-off-zoom.png` vs `hair-on-zoom.png`.
    `scripts/_schem_ref.ts --no-bridge` is the A/B switch and still reproduces
    the pre-fix hash `d158beb…f3fd7` exactly, so the pass is provably the only
    change.
  - **Two "more accurate" voxelization rewrites were MEASURED AND REJECTED
    (2026-09-08) — don't retry them without a visual A/B.** Both are
    geometrically more correct than what ships and both look worse.
    1. **Exact triangle/cell overlap (Akenine-Möller SAT) instead of the
       surface pass's bounding-BOX fill.** Correct: the box fill marks cells a
       slanted triangle never enters. But the over-coverage is what carries
       sub-cell relief — with SAT, 21063's wall buttresses and arch recesses
       collapse flush into the wall behind them, and a curved part becomes a
       one-cell skin whose neighbours win half its boundary cells, so surfaces
       speckle. 1,190,999 → 1,049,085 cells. See
       `output/schem-backlog/before-z2.png` (ships) vs `sat-z2.png` (rejected).
    2. **Half-open cell lattice (cell g owns [g·c,(g+1)·c), floor instead of
       round).** Makes a part's dimensions exactly right — a 2×4 brick is
       10×7×20 cells at cellLDU 4 instead of 11×8×21 — and puts the ray lattice
       at true cell centres (origins are `(g+0.5)·c`, so today's rounding samples
       a cell CORNER). But every LEGO face is a multiple of 4 LDU, i.e. exactly
       on a lattice boundary at cellLDU 4, so tie-breaking decides every
       surface: −25.7% cells and the same flattening plus worse noise
       (`after-z2.png`). Centred cells over-cover by half a cell per side and
       that conservative bias is the fidelity.
    Measurement tools kept: `scripts/_vox_stats.ts` (set-level cells / bridge /
    time), `scripts/_vox_partcheck.ts` (per-part cells vs the part's real LDU
    extent + enclosed-air holes), `scripts/_vox_range.ts` (emitted cell range vs
    exact extent), `scripts/_schem_diff.ts` (decoded gained/lost/recoloured).
    `scripts/schem-external-check.mjs` now also accepts a `.schem` path directly,
    so two pipeline builds can be A/B'd in schemat.io without re-exporting.
  - **Partial blocks: slabs + stairs (2026-09-08).** `engine/block-shapes.ts`,
    behind the `Block shapes` MC setting (**ON by default**), run by
    `runSchemPipeline` after `fillSingleVoxelGaps`; **bricks source only** (an
    uploaded grid is already blocks). It never creates or removes a cell — it
    replaces one SOLID palette entry with another — so the over-coverage rule
    above still holds and a one-cell-thick feature keeps its cell either way.
    Two passes:
    * **occupancy → slab.** The voxelizer records per-cell vertical occupancy
      (`VoxelizeOptions.shapes`, 2-3 B/cell): each part's real world-Y extent
      clamped to each cell it emitted, unioned as a hull. A cell under 0.75 of
      its height with the mass on ONE side of the midline becomes a slab —
      **and only when the half it gives up is air anyway**, which is what keeps
      an interior seam (two stacked bricks share a boundary cell whose
      occupancy unions to "full") a cube. The proposal's literal rule
      ("bottom ≥0.6, top ≤0.2") was CORRECTED: centred cells put most of a
      stacked plate into the brick's own boundary cell and only ~10% into the
      cell above, so the commonest plate arrangement in LEGO scored 0.2 and
      stayed a cube (21063: 1,813 → 2,775 candidates at cellLDU 20).
    * **slope → stairs.** Membership from the LDraw library's OWN description
      line (350 parts start `Slope Brick`; 32-60° single-face only, so cheese
      31° and the steep/double/convex families are out) — NOT a part-id list,
      which would be stale immediately (`3040`/`3665` are `~Moved to` stubs).
      Direction and inverted-ness come from the part's triangles
      (`analyzeSlope`). **`facing` is the FULL-HEIGHT side** — verified by
      rendering (`output/schem-backlog/schemat-io-stair-flush.png`), NOT from
      this repo's generator, whose gable code reads inconsistently and which
      asks for the non-existent `minecraft:smooth_stone_stairs`. First attempt
      read normal slope 3040b as inverted: LEGO parts are hollow and studded, so
      a lattice cell inside a stud's top disc reports the part's HIGHEST surface
      as its lowest point. Top gradient is primary; the underside is consulted
      only when the top is flat.
    * **The ceiling: vanilla has NO slab or stair for any dyed family.** The
      DEFAULT tables emit ~97% concrete, so on 21063 only 5,355 of 87,800
      candidate cells (sandstone) can take a shape; 71,150 are concrete. No
      near-colour substitution is made — a quartz slab on a concrete wall is a
      visible material seam. `ShapeStats.noVariantByBlock` reports exactly what
      a slab-capable palette unlocks; the **Textured + shapes** profile below is
      that palette, and it takes 21063 to 55,722 slabs + 1,980 stairs.
    * **The residue, and why a CARPET does not fix it (slice 6, measured then
      REMOVED).** `<colour>_carpet` is the only partial shape vanilla gives a
      dyed colour, so it is the only thing that could reach the black cells the
      slab table structurally cannot. At the safe threshold (occupancy ≤0.25,
      where 1/16 of a block really is the nearest shape) it fired on **251 of
      87,800** cells and on **zero** of 21063's 16,688 black ones (they sit at
      0.4-0.7 of their cell). At the threshold the no-slab arithmetic implies
      (~0.53, since the alternative is a whole cube) it thins the top row of
      every dyed wall to a sheet — the exact "sub-cell relief collapses" failure
      that got both voxelization rewrites rejected. And unlike a slab it is a
      MATERIAL change (concrete→wool), breaking the "0 recoloured" property every
      gate here is written against. Don't re-add it; the reasoning lives on
      `ShapeStats.noVariantByBlock`'s docs.
    * Gates: **flag-off must ALWAYS reproduce the no-shapes hash**; shapes-ON is
      gated by CONTENT DIFF, never by hash. `scripts/_schem_diff.ts` separates a
      shape refinement from a recolour; 21058 shows 0 gained / 0 lost /
      0 recoloured / 20,793 shaped. `scripts/_schem_ref.ts --no-shapes` and
      `scripts/_export_browser_check.mjs --shapes on|off` are the A/B switches
      (`_schem_ref.ts --profile=<id>` A/Bs a palette).
      Tests: `test/block-shapes.test.ts`, `test/schem-block-states.test.ts`.
  - **Semantic elements: panes, fences, walls, bars, ladders (2026-09-08).**
    `engine/part-elements.ts`, same `Block shapes` toggle, run by
    `runSchemPipeline` BEFORE the slab/stair pass and zeroing `hints.element`
    for every cell it declines (so a declined cell can still become a slab).
    Same contract: one solid palette entry for another, footprint unchanged.
    * **Membership is the LDraw description line again**, never a part-id list.
      `Glass for …` → `<colour>_stained_glass_pane`/`glass_pane`; `^Fence` → the
      wood fence or stone wall of the cell's OWN material; `Lattice` →
      `iron_bars`, and only in a neutral gray/metal (iron_bars is a fixed
      colour, so anywhere else the swap is a recolour); `Ladder` →
      `ladder[facing]`. Connection states (`east/north/south/west`) are computed
      from the grid, so a window is a sheet of connected panes, not a row of
      posts.
    * **Ladder facing comes from the GRID, not the part.** The LDraw origin of
      "Plate 1 x 2 with Ladder" says nothing reliable about which face the rungs
      are on. A ladder is placed only where a solid cell sits BEHIND it
      (Minecraft's model hangs on the face opposite `facing`) and the climbing
      side is open; otherwise the cell keeps its cube.
    * **Resolution is part of the contract**: a Minecraft pane/fence/bar/ladder
      is ONE cell, so `MAX_ELEMENT_CELLS = 64` turns elements on at 1-2.5
      blocks/stud (a 1x4x6 window glass is ~5×8 cells) and off at 5, where the
      same glass is ~150 cells. Verified: 21063 at auto (cellLDU 4) runs no
      element pass at all.
    * **DOORS ARE DELIBERATELY REFUSED** (514 placements measured), and this was
      the proposal's headline element. Every LEGO door in the corpus is 3-4
      studs wide and 5-7 bricks tall; a Minecraft door is one block wide and two
      tall, so any mapping deletes ~95% of the part or leaves a door floating in
      a wall of cubes. Likewise "Grille" tiles/bricks (6,523 placements — SOLID
      mouldings; `iron_bars` would hole the wall), flora (1,533) and antennas
      (280), both of which would be recolours. `scripts/_element_survey.ts`
      reproduces every number (613 files, 530,695 placements).
    * Gates: 21325 at 1 block/stud → 65 fences + 14 bars; 60365 → 99 panes; both
      0 gained / 0 lost / 0 recoloured / 0 unshaped. Re-import through the real
      Upload-tab parser preserves dims, non-air and all 53 palette entries.
      Chrome (Worker path) reproduces the CLI's element counts exactly. Tests:
      `test/part-elements.test.ts`.
  - **Lanterns for the light fill (2026-09-08).** With `Block shapes` on, the
    interior light fill drops `lantern[hanging=false]` instead of a glowstone
    cube — same light level 15, reads as a lamp rather than a glowing floor
    tile. `LightFillOptions.floorLightBlock` is used only where something solid
    is below (a standing lantern otherwise pops off); with shapes off the light
    fill is byte-identical to before.
  - **Byte-identity is the gate.** With defaults **and `--no-shapes`** (auto /
    default profile / light fill OFF) `scripts/_schem_ref.ts` (driving the REAL
    shared pipeline) on 21063 gives sha256 `53dac11…9e40e2`, 1,190,999 non-air.
    **Re-derived 2026-09-08** (was `d158beb…f3fd7` / 1,189,251) by the contact
    pass above — deliberate, verified additive-only. The hash before that was
    `52d2211…4be6b` / 1,184,777, retired 2026-09-02 by the race fix — that one
    was reproducible only because the CLI's timing was. The seeded browser export is
    that grid **+16 cells** (1,189,267, confirmed in Chrome): the viewer's
    candidate-path list has the `p/48/` hi-res alias tail, so it resolves 7
    primitives (`1-12ring14`, `4-4aring`, …) that the bare export resolver
    misses. Nothing else differs — a seed built from the EXPORT resolver's own
    picks reproduces `d158beb…` exactly. `test/schem-pipeline.test.ts` proves
    the grid path is `bytes === encodeSchemBytes(grid)`.
- **External-viewer gate (S5, 2026-09-01)** — our importer round-trips whatever
  we write, so a palette/colour-space mistake is invisible internally (that's
  how S1 hid). Two halves:
  1. **Palette lint, offline** — `engine/palette-lint.ts` +
     `engine/mc-block-registry.json` (curated, verified Java 1.20 ids: the
     16-colour families + solids + light sources). `test/palette-lint.test.ts`
     asserts every value in BOTH colour tables, the fallbacks, the profile light
     blocks and a REAL exported .schem's `Palette` are `minecraft:<known id>`.
     A new block means adding it to the JSON deliberately. Since 2026-09-08 the
     `[k=v,…]` STATE tail is validated too (keys and values against a per-suffix
     schema for `_slab`/`_stairs`/`_pane`/`_fence`/`_wall`/`ladder`/`lantern`/
     `iron_bars`; syntax + duplicate keys otherwise) — a state
     string is where a plausible typo hides best, since `[type=lower]` and
     `[facing=up]` round-trip through our own encoder and importer perfectly and
     only fail in Minecraft. Registry discipline: a shape id is listed only for
     a base material already verified in `blocks`, and only where vanilla really
     has it (`smooth_stone_slab` exists, `smooth_stone_stairs` does not — and
     `src/gen/material-resolver.ts` still asks for the latter, a pre-existing
     generator bug this lint would catch if that path were linted).
  2. **Browser gate** — `node scripts/_export_browser_check.mjs [model.io] [label]`
     (node, dev server on 4000) drives the REAL LEGO tab in Chrome: it reads the
     ⚙ MC settings resolution list, uploads a model, exports a `.schem` through
     the Web Worker and reports the phases the progress banner showed. Verified
     2026-09-08: 71043 (5,936 bricks) exports in **3.2 s** with a warm geometry
     cache — banner phases `voxelizing 1…85% → joining parts → closing surface
     holes` — 637,850 blocks at 2.5×/stud; 76416-1 cold (no IDB cache) 157 s,
     dominated by part fetches, not voxelization.
  3. **schemat.io, scripted + manual** — `node scripts/schem-external-check.mjs`
     (node, NOT bun: `chromium.launch` hangs under bun here; `channel:'chrome'`)
     exports 21063 through the shared pipeline, checks the baseline sha256,
     uploads it to schemat.io/view and screenshots to `output/schem-backlog/`.
     Verified 2026-09-01: white castle, solid walls, green/brown base — no
     translucent walls, no magenta terrain. NOT in CI (third-party site).
- **Bedrock Edition export: native `.mcpack`, no lossy hop (2026-09-08).**
  The user's previous route was our Java `.schem` through `../HotSchem`, and that
  conversion is where quality was lost. Verified from HotSchem's own source
  (`HotSchem_BP/scripts/main.js`, `HotSchem-Importer.html`): it does **no block-id
  renaming at all**, so every Java id whose Bedrock name differs fails
  `BlockPermutation.resolve` and becomes **air** (`bricks`, `nether_bricks`,
  `red_nether_bricks`, `end_stone_bricks`, `stone_slab`, `cobblestone_stairs`,
  `snow_block`, `magma_block`, `slime_block`, `rooted_dirt`, `jack_o_lantern`,
  `light_gray_glazed_terracotta`, `prismarine_brick_stairs`,
  `end_stone_brick_stairs` — 14 of the ids our palette emits); it drops
  `type=double` (a full block becomes a half); and it sends ladder `facing` to
  `minecraft:cardinal_direction`, which `ladder` does not have (Bedrock uses
  `facing_direction`), so every ladder falls back to one default orientation.
  Its README says as much: "block-state translation is partial".
  - **The format**: `.mcstructure` is Bedrock's native placeable structure —
    little-endian NBT, **uncompressed, NO file header** (unlike `level.dat`'s
    8-byte version+length prefix), unnamed root compound. `block_indices` is a
    TAG_List of exactly **two** TAG_Lists of TAG_Int sharing one palette (layer 1
    is waterlogging; we write all `-1`). Cells run **Z fastest**:
    `index = x*sizeY*sizeZ + y*sizeZ + z` — the documented 2×3×4 example is
    pinned in `test/mcstructure.test.ts`, because getting it wrong transposes the
    whole model and no palette check would notice. `-1` means "leave the existing
    block", so air is written as an explicit `minecraft:air` entry and a placed
    model CLEARS its own box instead of having terrain poke through its interior.
    `web/src/engine/mcstructure-encode.ts`; LE writers added to `byte-writer.ts`.
  - **The mapping is DATA, generated from Mojang's own registry.**
    `scripts/gen-bedrock-blocks.mjs` pulls
    `bedrock-samples metadata/vanilladata_modules/mojang-blocks.json` (every
    Bedrock id, every state name, every allowed value) → checked-in
    `web/src/engine/bedrock-block-states.json` (444 blocks, 18 properties, 51
    double-slab ids), scoped to the ids `mc-block-registry.json` allows. The
    generator FAILS if a rename target does not exist, and forward-checks the
    result against `main` so an id Mojang removed fails there, not in a world.
    `engine/bedrock-blocks.ts` layers the translation on top and has **no silent
    fallback** — `toBedrockBlock` returns null and the gap is reported.
    `test/bedrock-blocks.test.ts` asserts every id in the registry maps.
  - **Three versions must agree, and 1.21.40 is the measured floor.** Generator
    ref `v1.21.40.3`, manifest `min_engine_version [1,21,40]`, palette `version`
    stamp `18163712` (= 0x01152800 = 1.21.40.0). The flattening arrived in waves:
    1.21.20 moved `stonebrick`+`stone_brick_type` → `stone_bricks`,
    `stone_block_slab4` → `normal_stone_slab` and the `dirt`/`sand`/`quartz_block`
    type states; **1.21.30** the whole wall family and `purpur_pillar`; **1.21.40**
    added `mushroom_stem`. Generating from a newer ref would ship an id a 1.21.40
    client lacks; from an older one, 15 of our ids don't resolve. Bedrock runs its
    upgrade schemas FORWARD from the stamp, so an older stamp is the safe
    direction (packs stamping 1.18.10.1 still load) — a stamp newer than the
    client has no downgrade path.
  - **The traps, all pinned by tests.** Bedrock's `stone_stairs` IS *cobblestone*
    stairs and its stone stairs are `normal_stone_stairs` — both names exist in
    both editions with different materials, so swapping them is invisible.
    `snow`/`snow_block` swap meaning across editions. Java `terracotta` is
    `hardened_clay`. Light gray glazed terracotta is `silver_glazed_terracotta`.
    A **double slab is its own block** and where "double" goes is data, not a rule
    (`oak_double_slab` but `waxed_double_cut_copper_slab`). Slabs use
    `minecraft:vertical_half` (string), NOT `top_slot_bit` (used by zero blocks
    now); stairs use `weirdo_direction` (**int** 0-3: east 0, west 1, south 2,
    north 3) + `upside_down_bit` (**byte**) and have no `shape`; walls use
    `wall_connection_type_*` where Java's `low` is **`short`**; panes, iron bars
    and fences carry NO connection states (Bedrock recomputes them) so Java's
    north/south/east/west must be DROPPED or the permutation is unresolvable. The
    NBT *type* matters as much as the name — an int written as a byte silently
    lands the block on its default permutation.
  - **Tiling**: Bedrock caps one structure at **64×384×64**, so a big model is
    split (`planStructureTiles`), each tile TRIMMED to its own occupied bbox and
    empty tiles dropped — `block_indices` costs a flat 4 bytes/cell/layer with no
    packing, so trimming is what keeps a 1.19M-block model at 233 KB. Because
    each tile records its grid origin, the pack also ships
    `functions/craftmatic/<name>.mcfunction` — one `structure load … ~dx ~dy ~dz`
    per tile — so the player stands at the corner and runs **one** `/function`
    instead of placing 15 pieces at computed coordinates. `engine/mcpack.ts`.
  - **Pack identity is deterministic, not random**: manifest UUIDs are hashed
    from the filename stem, so re-exporting a set UPDATES the pack the player
    already has rather than adding a duplicate with the same name, and the output
    is reproducible enough to test. `format_version: 2`, one `data` module,
    manifest at the ZIP ROOT, structures under an explicit `structures/craftmatic/`
    namespace (a file directly in `structures/` silently becomes `mystructure:…`).
    `createZip({alwaysDeflate:true})` — no official word on whether Bedrock
    accepts STORED entries, and DEFLATE costs nothing.
  - **Verified / not verified.** Verified offline: the bytes decode with
    `prismarine-nbt` in `little` mode and with an independent hand-written Python
    LE-NBT reader (real 21063 pack, 4.98 MB tile, consumed to the last byte);
    tiling reassembles cell-for-cell; the zip passes Python `zipfile.testzip()`
    with DEFLATE throughout and a root manifest. **NOT verifiable without a
    Bedrock client**: that the game accepts the `version` stamp, that a complete
    `states` compound is preferred over a partial one (undocumented — vanilla
    always writes complete), the ladder `facing_direction` north/south
    convention (derived from the shared pre-1.13 metadata, not a quoted
    cross-edition mapping), and `huge_mushroom_bits` 14/15 for cap/stem.
    Activating ANY external behavior pack permanently disables achievements in
    that world — the in-pack README says so.
