# Schem conversion rearchitecture — partial blocks, semantic elements, expanded color

Proposal, 2026-09-08. Audit-grounded: every "we currently do X" below was verified in
code this session; every count was measured (commands inline). Nothing here is
implemented; see the slice plan at the end.

## 0. The user's question, answered plainly

**Are we using slabs, stairs, walls, trapdoors, doors, gates, carpets, ladders,
panes today? No — none of them, anywhere.** The emitted vocabulary is full
1×1×1 blocks only: 16 concretes, 16 stained glasses, `glass`, `sandstone`, two
terracottas, `gold_block`, `iron_block`, plus `glowstone`/`sea_lantern` from
light-fill. Verified three ways:

- `mc-block-registry.json` (what the palette lint accepts) contains **zero**
  ids matching `slab|stair|wall|trapdoor|door|carpet|pane|fence|ladder|gate|
  button|layer` (grep over the file: 0 hits).
- Both color tables (`ldraw-colors.ts`, `studio-colors.ts`) map exclusively to
  full blocks (33 distinct ids in the LDraw table, 28 in the Studio table).
- A real export decoded through our own importer (21063 Lion Knights' Castle,
  1.19M non-air cells): 96.9% concrete family, 1.0% sandstone, ~0.6% stained
  glass/glass, ~0.2% gold/iron — 100.0% full cubes.

Every plate, tile, slope, dome, door, window and fence becomes a stack of full
cubes. That is the single largest fidelity loss left in the pipeline, and it is
addressable: **24.8% of all corpus part placements are plates/tiles**
(slab-class geometry) and **10.5% are slopes/curved parts** (stair-class),
measured over 450 corpus models / 666,007 placements (OMR + IOModel2V2 +
DbixConvV3 samples; regex over type-1 lines).

## 1. Current state (what ships)

Pipeline (`engine/schem-pipeline.ts`, worker-hosted): bricks →
`voxelizeLDrawGeometry` (parity-fill of real triangle geometry, centred cells)
→ `bridgePartContacts` (sub-cell gap weld, 2026-09-08) →
`fillSingleVoxelGaps` → optional light-fill → `encodeSchemBytes` /
litematic. Each cell holds ONE string block id; color chosen by the LDraw/
Studio color of the ray-owning triangle; resolution from the auto ladder
(1–5 blocks/stud; 10 opt-in).

Two facts make this proposal cheap to carry in the formats:

- **`.schem` palette keys are already free-form strings**
  (`encodeSchemBytes` writes `paletteEntries` verbatim), so
  `minecraft:oak_stairs[facing=north,half=bottom]` needs zero encoder work.
- **The litematic encoder already implements state decomposition** —
  `decomposeBlockState()` splits `name[k=v,...]` into `Name` + `Properties`
  NBT. It has simply never received a stateful id.

Importer: `parseSchemFile` keeps palette strings as-is → round-trip through
the Upload tab preserves states byte-for-byte. The Upload-tab *renderer*
colors by exact block-id lookup, so stateful ids need a strip-states-then-look-
up fallback (small, listed in slice 1) or they render as the gray fallback.
schemat.io and Minecraft render states natively — no external work.

## 2. The available Minecraft vocabulary (Java 1.20, our registry target)

**Full-block color families** (per 16-color set unless noted): concrete,
concrete_powder, wool, terracotta (+plain), glazed_terracotta, stained_glass —
our registry already lists the families but the tables use only concrete +
stained_glass + 2 terracottas. Beyond the 16-color sets: ~55 stone/quartz/
sandstone/prismarine/deepslate hues, 11 plank + 9 log woods, the 4-step
copper oxidation ramp (orange→teal — ideal for LDraw 484/107 transitions),
metal/gem blocks, snow/ice/calcite whites, mud/soul browns. Realistic usable
gain: **~40 additional distinct hues** over today's 33, most of them the
muted browns/tans/grays LEGO actually uses (dark tan, reddish brown, sand
green have no concrete match).

**Partial-geometry elements and their states** (all carriable today per §1):

| element | states | LEGO analogue |
|---|---|---|
| slabs (stone/wood/copper…) | `type=top/bottom/double` | **plate (⅓ brick), tile** — 24.8% of placements |
| stairs | `facing`, `half`, `shape` (5) | 45°/33° slopes, curved slopes — top-15 part 54200 alone is 7,076 placements in the sample |
| carpets (16 colors) | — | tile/plate at 1-block/stud scale (1/16 height) |
| snow layers | `layers=1..8` | variable-height thin caps |
| walls | `up`, per-side low/tall | fences 3185/6079, lattice, masonry columns |
| fences + gates | side connects; gate `facing/open` | fence 3185/30055 (515), gates |
| doors (11 wood + iron + copper) | `half`, `facing`, `hinge`, `open` | LEGO doors 60623/3861/… (749) |
| trapdoors | `facing`, `half`, `open` | hatches, half-height panels, shutters |
| glass panes / iron bars | side connects | window panes 60601/57894 (2,912 windows/frames), grilles |
| ladders | `facing` | ladder 4175/6020 (450) |
| buttons / pressure plates | wall/floor | studs at 1-block/stud, greebles |
| candles/lanterns/chains/end rods | — | antennas 4073 (7,506!), bars, lightsabers |
| flower pots, heads, banners | — | minifig-scale decoration (stretch) |

## 3. Proposed architecture — four composable passes

The rejected-rewrites finding (2026-09-08) is the load-bearing design
constraint: *exact* geometry (SAT overlap, half-open lattice) made full-block
output worse because centred-cell over-coverage is what preserves sub-cell
relief. The corollary: **don't change how cells become solid; change what a
solid cell is allowed to BE.** All four passes below run *after* (or beside)
the existing voxelizer and only refine cells/parts we already emit — the
full-block output remains the fallback at every step, which keeps every
existing gate (content diff must show refinements, never losses).

### Pass A — part-identity element mapping (pre-voxelization, highest win)
We know every part id + world transform *before* voxelizing. A curated table
(`engine/part-elements.ts`, data not code — same philosophy as
`ldraw-part-aliases.ts`) maps iconic parts directly to MC elements placed from
the part's own transform, and *excludes those parts from voxelization*:

- LEGO door parts → `minecraft:*_door[half,facing,hinge]` (2 cells tall at
  ≥2 blocks/stud; trapdoor at 1/stud).
- Window frames → panes/bars in the frame plane; frame rim keeps blocks.
- Fences 3185/30055/6079 → fence or wall runs; gates → `fence_gate`.
- Ladders 4175/6020 → `ladder[facing]` against their support face.
- Antenna/bar 4073-family verticals → `end_rod`/`chain`/`lightning_rod`.
- Orientation from the brick rotation matrix (the placement code already
  derives facing for arrowheads in the viewer; same math).

~50 rows covers the measured head of the distribution. Wins are *semantic* —
a door that opens, a window you can see through with a thin profile — which no
occupancy inference can recover. Gate: per-part before/after A/B; any part
whose mapped element misplaces (origin conventions vary) falls back to blocks.

### Pass B — slope/curve → stairs lookup (pre-voxelization, near-lookup)
LEGO slopes are cataloged families with known angle + direction in part space:
45° family (3037-3040, 3298…) → stairs 1:1; 33° double-length slopes → stairs
+ slab landings; cheese 54200 / curved 11477/50950/93273 → stairs at coarse
resolutions, blocks+slab crown at fine. Rotation matrix → `facing`;
upside-down slopes → `half=top` (LEGO's inverted slopes 3665/3660 map
exactly). This is data + one placement function, not inference. 10.5% of
placements. Resolution rule: at ≥5 blocks/stud a slope spans ≥5 cells and a
voxel staircase of full blocks already reads fine — stairs matter most at
1–2.5 blocks/stud, where a slope is 1–2 cells.

### Pass C — occupancy shape-fit (post-voxelization, the general net)
For cells NOT claimed by A/B: compute per-cell fractional occupancy +
height/face distribution (the SAT machinery we built and rejected for
solidification is *exactly* this instrument — reuse
`scripts/_vox_partcheck.ts`'s math, now safe because it only *refines* cells
the conservative pass already marked solid):

- occupancy ≥0.75 → full block (unchanged);
- bottom-half ≥0.6, top ≤0.2 → `slab[type=bottom]` (mirror for top);
- one dominant vertical face + wedge profile → stairs with that facing;
- ≤0.15 and floor-adjacent → carpet (1/stud tier) or leave full (finer tiers);
- everything ambiguous stays a full block (the over-coverage fidelity rule).

This catches plate/tile tops of walls, roof edges built from plates, and the
24.8% slab-class mass generically. It is resolution-aware by construction: at
1 block/stud a plate occupies 0.4 of its cell → slab; at 2.5/stud it fills its
own cell → full block, correctly.

### Pass D — perceptual color over an expanded palette (orthogonal)
Replace the hand-mapped hex→family tables' nearest-match with OKLab
nearest-neighbour over a *profile-defined* candidate set. The block-profile
seam (`engine/block-profiles.ts`) was built for exactly this: ship profiles as
data — **Smooth** (concrete/terracotta/smooth stone/quartz/copper only; no
texture noise — the default, closest to today), **Textured** (adds planks,
stone bricks, wool for cloth-colored parts), **Vanilla-build** (survival-
obtainable). Glazed/patterned blocks stay out of the default (measured harm:
pattern noise on smooth LEGO surfaces). Trans-colors keep stained glass;
pearl/metallic ids keep metal blocks. Expected: dark tan, reddish brown, sand
green, olive — LEGO's most common "muddy" colors — stop collapsing into the
nearest gray/brown concrete.

### Composition order
A and B mark parts consumed + emit elements with states; voxelizer runs on
the remainder; C refines unclaimed cells; D colors everything; bridge/gap/
light passes unchanged (bridge runs before C so shape-fit sees welded
contacts). All four are independent settings (see §5) — each can ship, be
A/B'd, and be reverted alone.

## 4. Compatibility and placement

- **Worker pipeline**: A/B are a pre-step in `runSchemPipeline` (bricks in,
  {remainingBricks, elements[]} out); C a post-step over the grid; D replaces
  the colorFn. All pure, all testable offline like every existing stage.
- **Palette lint**: registry gains the partial-block ids + a state-string
  validator (`name[k=v]` → name must be known, keys from a per-element
  allowlist). Lint stays the external-viewer tripwire.
- **Round-trip**: `.schem`/litematic carry states already (§1). Upload-tab
  renderer needs strip-states color fallback (~10 lines) so re-imported
  stateful schems still render colored; `BlockGrid` needs nothing (ids are
  strings).
- **Build guide**: layer slices show element names as-is; no change required.
- **Resolution interaction** is explicit per pass (B and C rules above); the
  settings popover's resolution choice therefore *changes which passes bite*,
  which the describePlan line should state ("plates → slabs at this scale").

## 5. Slice plan (each gated, lowest-risk/highest-visibility first)

| # | slice | size | gate |
|---|---|---|---|
| 1 | Registry + lint for stateful ids; Upload-render strip-state fallback; schemat.io smoke with a hand-built stateful .schem | S | lint green; schemat.io renders stairs/slab/door correctly from our encoder |
| 2 | **Pass C minimal: plates/tiles → slabs + carpets** (occupancy thresholds only, no stairs) behind a "Partial blocks" setting, ON by default at 1–2.5 blocks/stud | M | content diff = refinements only; 21063 + a plated roof set A/B in schemat.io; tests with synthetic plate/tile grids |
| 3 | **Pass B: slope families → stairs** (45° first, then 33°/inverted/cheese) | M | slope-heavy set (8441 or a roofed City set) A/B; per-family placement tests |
| 4 | **Pass D: OKLab + Smooth profile** as a second real profile (default stays current until A/B'd corpus-wide) | M | ΔE distribution before/after over the 16+40 palette; 3-set visual A/B |
| 5 | **Pass A: doors/windows/fences/ladders table** (top ~20 parts first) | M-L | per-part A/B renders; misplaced → fallback; minifig-scale sets (City) as fixtures |
| 6 | Stairs `shape` corners, walls for lattice/fence intersections, snow layers, rods/chains for bars/antennas | L | same gates, element by element |

Slices 2–3 alone convert ~35% of placements to honest partial geometry at
coarse resolutions — the visible "LEGO-ness" win (stepped roofs, thin floors,
seated tiles) — with the full-block output as the universal fallback and the
`--no-*` flags reproducing today's bytes for the identity gate.

## 6. Risks / honest limits

- Element origin conventions (door hinge corner, ladder face) vary per part —
  that's why Pass A is a curated, per-part-verified table, not a rule.
- Shape-fit thresholds can flicker on noisy surfaces; the ambiguous→full-block
  default and the rejected-rewrites lesson (never trade over-coverage away)
  bound the damage to "less refinement", never holes.
- WorldEdit `.schem` v2 + litematic both carry states, but some third-party
  tools normalize unknown states — the schemat.io + re-import gates cover the
  two surfaces we promise.
- Pass D changes every export's palette; it ships as a non-default profile
  until the corpus A/B says otherwise.
