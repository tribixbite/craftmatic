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

- Core schematic parse/write: complete
- Block registry + colors: complete (170+ entries)
- 2D PNG renderer: complete (floor plans, cutaway iso, exterior)
- 3D viewer: complete (Three.js dev server + HTML export)
- Structure generator: complete (5 styles, 16 room types)
- Cross-conversion: complete (schem↔three bidirectional)
- CLI: complete (info, render, view, export, gen commands)
- Texture atlas: placeholder (TODO: procedural generation)
- Tests: pending
