# Architecture

## Module Layout

```
src/
├── index.ts              # Public API re-exports
├── cli.ts                # Commander CLI (6 commands)
├── nbt/
│   ├── reader.ts         # NBT parsing via prismarine-nbt
│   └── writer.ts         # NBT binary writer (Big Endian)
├── schem/
│   ├── types.ts          # BlockGrid class (3D voxel grid)
│   ├── parse.ts          # .schem → SchematicData/BlockGrid
│   ├── write.ts          # BlockGrid → .schem file
│   └── varint.ts         # Varint encode/decode
├── blocks/
│   ├── registry.ts       # Block state parsing + queries
│   ├── colors.ts         # Block → RGB color map (280+ entries)
│   └── textures.ts       # Block → texture face mapping
├── gen/
│   ├── generator.ts      # Main generation orchestrator (10 structure types)
│   ├── styles.ts         # 9 style presets (fantasy…underwater)
│   ├── rooms.ts          # 20 room type generators
│   ├── structures.ts     # Structural + terrain building primitives
│   └── furniture.ts      # Furniture placement helpers (19 functions)
├── render/
│   ├── png-renderer.ts   # 2D PNG (floor plan, cutaway iso, exterior)
│   ├── three-scene.ts    # Three.js scene builder + viewer serializer
│   ├── server.ts         # Express dev server for 3D viewer
│   ├── export-html.ts    # Self-contained HTML export
│   ├── texture-atlas.ts  # ProceduralAtlas — 230+ textures (Faithful 32x + procedural)
│   ├── item-sprites.ts   # 17 hand-drawn 16x16 furniture sprites
│   └── block-mesh.ts     # Block mesh (re-exports three-scene)
├── convert/
│   ├── schem-to-three.ts # .schem → Three.js Object3D
│   └── three-to-schem.ts # Three.js → .schem via raycasting
└── types/
    └── index.ts          # Shared TypeScript types
```

## Data Flow

### Parse Pipeline
```
.schem file → gzip decompress → NBT parse → SchematicData → BlockGrid
```

### Write Pipeline
```
BlockGrid → SchematicData → NBT compound → gzip compress → .schem file
```

### Generation Pipeline
```
GenerationOptions → calculateDimensions → BlockGrid.create()
  → foundation → walls → floors → stairs → rooms → roof → chimney
  → writeSchematic()

Structure-specific generators (v0.2.0):
  cathedral: nave + side aisles → rose window → apse → bell tower → flying buttresses
  bridge: parabolic arch → deck + railings → end towers → water indicator
  windmill: circular base → tapering floors → blade structure → conical roof
  marketplace: perimeter wall → stall grid → central well → covered walkway
  village: sub-structure generation → pasteGrid composition → path network → trees
```

### Render Pipeline (2D)
```
BlockGrid → to3DArray() → ensureAtlas() → per-block texture lookup
  → blitTextureTile / blitTextureIso* (nearest-neighbor sampling from 32x32 atlas)
  → item sprite overlay (16x16 furniture shapes)
  → pureimage encodePNG → Buffer
```

### Texture Pipeline
```
textures/blocks/*.png (334 Faithful 32x32 CC-BY-SA)
  → initDefaultAtlas() loads + scales to tileSize
  → ProceduralAtlas (230+ entries, hybrid: real PNG + procedural fallback)
  → getBlockTextures(blockState) → per-face texture names (top/bottom/north/south/east/west)
  → atlas.entries.get(textureName)?.data → 32x32 RGBA pixel array
  → item-sprites.ts: 17 hand-drawn 16x16 sprites for furniture (beds, chests, lanterns, etc.)
```

### Render Pipeline (3D)
```
BlockGrid → serializeForViewer() → JSON → HTML template (Three.js from CDN)
  → getGeometryKind() classifies block shape (10 types: cube, slab, fence, torch, etc.)
  → InstancedMesh per color+geometry group
  → loadBlockTexture() → Faithful 32x PNG via Vite import.meta.glob (fallback: procedural)
  → NearestFilter for crisp pixel-art look
  → Emissive glow for light-emitting blocks
  → OrbitControls → WebGL canvas
```

## Key Classes

### BlockGrid (`src/schem/types.ts`)
Central data structure: a 3D voxel grid stored as `string[]` in YZX order.

- `get(x, y, z)` / `set(x, y, z, blockState)` — single block access
- `fill(x1, y1, z1, x2, y2, z2, blockState)` — volume fill
- `walls(x1, y1, z1, x2, y2, z2, blockState)` — hollow box
- `addChest(x, y, z, facing, items)` — chest with inventory
- `encodeBlockData()` → varint-encoded `Uint8Array`
- `to3DArray()` → `string[][][]` indexed as `[y][z][x]`

### NBTWriter (`src/nbt/writer.ts`)
Binary NBT writer using Big Endian format. Supports all NBT tag types.

### StylePalette (`src/gen/styles.ts`)
40+ field interface defining materials for every building element:
walls, floors, ceilings, stairs, roof, timber, glass, doors, etc.

## Dependencies

| Package | Purpose | Required |
|---------|---------|----------|
| prismarine-nbt | NBT parsing | yes |
| commander | CLI args | yes |
| pureimage | PNG encoding (pure JS) | yes |
| three | 3D scene construction | yes |
| express | Dev server | yes |
| chalk | CLI colors | yes |
| ora | CLI spinners | yes |
| sharp | Fast PNG encoding | optional |
