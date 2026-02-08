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

## Status

- [x] Core schematic parse/write (prismarine-nbt + custom NBT writer)
- [x] Block registry + colors (170+ entries with prefix matching)
- [x] 2D PNG renderer (floor plans, cutaway iso, exterior via pureimage)
- [x] 3D viewer (Three.js dev server + self-contained HTML export)
- [x] Structure generator (5 styles, 16 room types, seeded PRNG)
- [x] Cross-conversion (schem↔three bidirectional)
- [x] CLI (info, render, view, export, gen commands)
- [x] README + docs/specs
- [x] GitHub repo (tribixbite/craftmatic)
- [x] Texture atlas (94 procedural 16x16 textures, 10 pattern types)
- [x] Tests (59 tests, all passing)
- [ ] npm publish
