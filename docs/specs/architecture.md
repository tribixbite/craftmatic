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
│   ├── colors.ts         # Block → RGB color map (170+ entries)
│   └── textures.ts       # Block → texture face mapping
├── gen/
│   ├── generator.ts      # Main generation orchestrator
│   ├── styles.ts         # 5 style presets (fantasy, medieval, modern, gothic, rustic)
│   ├── rooms.ts          # 16 room type generators
│   ├── structures.ts     # Structural building primitives
│   └── furniture.ts      # Furniture placement helpers
├── render/
│   ├── png-renderer.ts   # 2D PNG (floor plan, cutaway iso, exterior)
│   ├── three-scene.ts    # Three.js scene builder + viewer serializer
│   ├── server.ts         # Express dev server for 3D viewer
│   ├── export-html.ts    # Self-contained HTML export
│   ├── texture-atlas.ts  # Texture atlas UV lookup (placeholder)
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
```

### Render Pipeline (2D)
```
BlockGrid → to3DArray() → pixel buffer (RGBA) → pureimage encodePNG → Buffer
```

### Render Pipeline (3D)
```
BlockGrid → serializeForViewer() → JSON → HTML template (Three.js from CDN)
  → InstancedMesh per color group → OrbitControls → WebGL canvas
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
