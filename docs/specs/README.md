# Craftmatic Specifications

Technical specifications and design documents for the craftmatic library.

## Table of Contents

| Document | Description |
|----------|-------------|
| [Architecture](architecture.md) | Project structure, module layout, and data flow |
| [Schematic Format](schematic-format.md) | Sponge Schematic v2 format details and parsing |
| [Block Mapping](block-mapping.md) | Block state → color/texture mapping system |
| [Generation Styles](generation-styles.md) | Style preset system for structure generation |
| [Conversion Spec](conversion-spec.md) | Bidirectional Three.js ↔ .schem conversion |
| [Rendering](rendering.md) | 2D PNG and 3D rendering pipeline |
| [Web Application](web-app.md) | Browser-based toolkit with Vite + Three.js |

## Status

### Core Library
- [x] Core schematic parse/write (prismarine-nbt + custom NBT writer)
- [x] Block registry + colors (260+ entries with prefix matching)
- [x] 2D PNG renderer (floor plans, cutaway iso, exterior via pureimage)
- [x] 3D viewer (Three.js dev server + self-contained HTML export)
- [x] Structure generator (5 styles, 16 room types, seeded PRNG)
- [x] Cross-conversion (schem↔three bidirectional)
- [x] CLI (info, render, view, export, gen, atlas commands)
- [x] Texture atlas — 334 Faithful 32x CC-BY-SA textures + procedural fallback (230+ entries)
- [x] Tests (93 tests, all passing)
- [x] Quality audit (all 5 styles × 3 floor counts, 75 renders verified)
- [x] Cutaway slider fix — proper instance matrix store/restore

### Structure Types
- [x] All 5 structure types: house, tower, castle, dungeon, ship
- [x] Gothic style overhaul: purpur block walls + deepslate interiors + soul lanterns
- [x] Ship overhaul: 3-mast rigging (main/foremast/mizzen), dual sail tiers, crow's nest, bowsprit, deck details (wheel, barrels, rigging, figurehead)
- [x] Dungeon gatehouse entrance: corner mini-towers, battlements, arched gate
- [x] Solid gabled roofs (no more hollow/stripe rendering)
- [x] House/castle front-face lighting: porch moved to high-Z (lit) side
- [x] Castle courtyard: cross-pattern paths, well, training grounds, market stalls
- [x] Rustic palette: birch planks + cobblestone for readable contrast

### Room Furnishing (v2)
- [x] 6 new furniture primitives: storageCorner, wallShelf, couchSet, armorDisplay, rugWithBorder, wallDecoration
- [x] 11 room generators densified: living, bedroom, kitchen, dining, foyer, study, library, throne, armory, forge, lab
- [x] Checkerboard floors (kitchen), bordered rugs, L-shaped couches, wall-mounted shelving
- [x] Castle-specific: raised 2-level dais in throne room, gold accents, multiple chandeliers

### Structure Detail (v3)
- [x] Ship cargo holds: barrel clusters, chest storage, hay bale cargo, hanging lanterns
- [x] Ship deck: railing lanterns (every 6 blocks), cargo hatch trapdoor
- [x] Dungeon corridors: dense torches (4-block), cobwebs, chains, cracked stone floors
- [x] Dungeon atmosphere: iron bar cell doors, bone block decorations near rooms
- [x] Tower radius 6→8 (interior ~8×8 → ~12×12), observation balcony with fence railing
- [x] Tower exterior banners on every floor at cardinal positions
- [x] Visual critique: all 10 structure/style combos verified at A- grade

### Web Application
- [x] Vite-based SPA with dark mode UI (mobile-responsive)
- [x] Structure generator UI with all 5 types, 5 styles, full controls
- [x] .schem file upload with drag-and-drop + browser NBT parser (pako)
- [x] Interactive Three.js 3D viewer with cutaway slider
- [x] Export: GLB (binary glTF), .schem, standalone HTML
- [x] Gallery with 12 pre-generated showcase structures
- [x] Isometric canvas thumbnails for gallery cards

### UI Polish
- [x] CSS animations (fadeInUp, shimmer, slideInOverlay)
- [x] Loading overlays for generation, upload, and gallery
- [x] Three.js code-split into separate chunk (~120KB gzip)
- [x] Export toolbar labels (GLB, .schem, HTML)
- [x] Inline viewer layout fix (position:relative, not absolute)
- [x] Loading overlay hidden-state fix (:not([hidden]) selector)
- [x] try/finally guards on viewer callbacks
- [x] Focus-visible keyboard styles on buttons/tabs/chips
- [x] Firefox scrollbar styling (scrollbar-width/scrollbar-color)
- [x] Removed user-scalable=no (accessibility)
- [x] theme-color meta + OG tags + noscript fallback

### Quality & Security
- [x] Three.js texture/material disposal in viewer cleanup
- [x] NBT parser safety: array length bounds + recursion depth limits
- [x] Upload file validation: type check, 50MB size limit, input reset
- [x] XSS prevention: HTML-escaped filenames in upload info
- [x] Export error feedback (toast on GLB/schem/HTML failures)
- [x] Production source maps disabled, pako split to separate chunk

### CI/CD
- [x] GitHub Actions CI (typecheck, test, build on Node 18/20/22)
- [x] GitHub Pages deploy workflow for web app
- [x] Playwright e2e tests (7 test scenarios, all passing)
- [x] README + docs/specs

### Published
- [x] npm publish — `craftmatic@0.1.0` on npmjs.org (maintainer: willstone)
- [x] `npx craftmatic` CLI with 7 commands (info, render, view, export, gen, atlas)
- [x] `npx craftmatic` (no args) serves web app + prints command summary

### v0.2.0 — Major Feature Expansion
- [x] 5 new structure types: cathedral, bridge, windmill, marketplace, village
- [x] 4 new style palettes: steampunk, elven, desert, underwater
- [x] 4 new room types: captains_quarters, cell, nave, belfry
- [x] Structure-specific room defaults (ship gets captains_quarters, dungeon gets cells, etc.)
- [x] 5 new furniture primitives: telescope, plateSet, mapTable, lightFixture, steeringWheel
- [x] 5 terrain/landscaping primitives: placeTree, placeHill, placePond, placePath, placeGarden
- [x] Village generator: 3-5 buildings + tower + marketplace, path network, trees
- [x] ~80 new block colors (copper variants, prismarine, sandstone, terracotta, coral, terrain)
- [x] Distinct 2D render markers for decorative items (telescope, lantern, candle, etc.)
- [x] Test suite expanded: 59 → 86 tests (new types, styles, rooms, benchmarks)
- [x] Web gallery expanded: 12 → 20 entries with new types/styles
- [x] Generator UI: all 10 structure types, 9 style presets

### v0.2.1 — Glorious Rendering
- [x] Faithful 32x textures: 334 block PNGs at 32×32 replacing 16×16 ProgrammerArt (CC-BY-SA)
- [x] Textured 2D rendering: atlas connected to floor plans, cutaway iso, and exterior iso
- [x] Texture blitting: nearest-neighbor sampling for top-down and isometric face projections
- [x] 17 hand-drawn item sprites: beds, chests, lanterns, flower pots, armor stands, etc.
- [x] 3D viewer: 10 non-cube geometry shapes (slab, fence, torch, lantern, chain, door, pane, etc.)
- [x] 3D viewer: Faithful 32x texture loading via Vite + emissive glow for lights
- [x] Style palette contrast fixes: elven foundation, desert wallAccent, gothic pillar
- [x] Room furnishing density: extra lights, plants, carpets, banners in 7 sparse rooms
- [x] Generator enrichment: exterior lanterns, courtyard trees, deck barrels, altar candles, lamp posts, varied stall goods
- [x] Test suite: 86 → 93 tests (item sprites, textured rendering, atlas coverage)
- [x] Showcase v3: 20 structures × 10 types × 9 styles with textured renders (102 PNGs)
