# Web Application

Browser-based Craftmatic toolkit built with Vite + Three.js.

## Architecture

```
web/
  index.html            Single-page application shell
  vite.config.ts        Vite build config with path aliases
  tsconfig.json         Browser-targeted TypeScript config
  src/
    main.ts             App entry: navigation, viewer overlay, event wiring
    style.css           Dark theme CSS with custom properties
    engine/
      nbt.ts            Browser NBT parser (DataView, no Node deps)
      schem.ts          .schem parser: pako decompress → NBT → BlockGrid
    viewer/
      scene.ts          Three.js scene builder with instanced meshes
      exporter.ts       GLB, .schem, and standalone HTML export
    ui/
      generator.ts      Structure generator form + controls
      upload.ts         Drag-and-drop .schem file upload
      gallery.ts        Pre-generated showcase with canvas thumbnails
```

## Module Imports

The web app imports browser-compatible modules from the core library via Vite path aliases:

| Alias | Resolves to | Usage |
|-------|-------------|-------|
| `@craft/*` | `../src/*` | Types, BlockGrid, colors, registry, generator |
| `@engine/*` | `./src/engine/*` | Browser NBT parser, .schem parser |
| `@viewer/*` | `./src/viewer/*` | Three.js scene, exporter |
| `@ui/*` | `./src/ui/*` | UI components |

Core modules used in browser (no Node.js APIs):
- `src/types/index.ts` — type definitions
- `src/schem/types.ts` — BlockGrid class
- `src/schem/varint.ts` — varint codec
- `src/blocks/registry.ts` — block state parsing
- `src/blocks/colors.ts` — block color map (260+ entries)
- `src/gen/generator.ts` — structure generation orchestrator
- `src/gen/styles.ts` — 5 style palettes
- `src/gen/rooms.ts` — 16 room generators
- `src/gen/structures.ts` — structural building primitives
- `src/gen/furniture.ts` — furniture placement

## Browser NBT Parser

Custom parser (`web/src/engine/nbt.ts`) replaces prismarine-nbt for browser use:
- Reads all 13 NBT tag types from ArrayBuffer via DataView
- Supports Compound, List, ByteArray, IntArray, LongArray
- Zero Node.js dependencies

## .schem Parser

`web/src/engine/schem.ts`:
1. Decompress gzip with `pako.inflate()`
2. Parse NBT via custom browser parser
3. Build reverse palette (index → block state)
4. Decode varint block data
5. Construct BlockGrid with `loadFromArray()`

## 3D Viewer

`web/src/viewer/scene.ts`:
- InstancedMesh per unique (color, blockName) group
- Procedural Canvas textures matching block type patterns
- PCFSoftShadowMap, ACESFilmicToneMapping
- OrbitControls with damping
- Occlusion culling (skip blocks surrounded by 6 solid neighbors)
- Cutaway slider with stored original matrices for restore
- **Inline cutaway slider** in embedded preview (horizontal range input, resets per generation)
- ResizeObserver for container-responsive sizing

## Export Formats

| Format | Method | Size |
|--------|--------|------|
| GLB | Three.js GLTFExporter (binary) | ~1-5 MB typical |
| .schem | Custom NBT writer + pako gzip | ~10-100 KB typical |
| HTML | Self-contained with CDN Three.js | ~50-200 KB typical |

## Build

```bash
npm run dev:web      # Dev server on port 4000
npm run build:web    # Production build → web/dist/
npm run preview:web  # Preview production build
```

## Deployment

GitHub Pages via `.github/workflows/deploy.yml`:
1. Runs on push to main
2. Runs typecheck + test + build
3. Builds web app with Vite
4. Uploads `web/dist/` as Pages artifact
5. Deploys to GitHub Pages
