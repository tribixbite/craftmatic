# Bidirectional Conversion: Three.js ↔ .schem

## Schem → Three.js (`src/convert/schem-to-three.ts`)

### Pipeline

1. Parse `.schem` file → `SchematicData` (palette + block data + entities)
2. Convert to `BlockGrid` (decoded 3D string array)
3. For each non-air block:
   - Skip fully occluded blocks (all 6 neighbors are solid)
   - Look up color from block registry
   - Group by material color
4. Create `THREE.InstancedMesh` per color group
   - Shared `BoxGeometry(1, 1, 1)`
   - `MeshStandardMaterial` with block color
   - Set instance matrices for block positions
5. Center the model: positions offset by `-width/2` on X, `-length/2` on Z
6. Return `THREE.Group` containing all instanced meshes

### Block Entity Handling

Block entities (chests, barrels) are rendered as regular blocks. Their inventory data is preserved in `userData` for consumers who need it.

### Performance

- Instanced rendering: one draw call per unique color
- Occlusion culling: interior blocks are skipped
- Typical mansion (8000 blocks) → ~60 instanced meshes

## Three.js → Schem (`src/convert/three-to-schem.ts`)

### Pipeline

1. Get bounding box of input `THREE.Object3D`
2. Create voxel grid at specified resolution (default: 1 unit = 1 block)
3. For each grid cell, raycast from 6 directions to determine occupancy
4. If ray hits geometry at this cell:
   - Extract material color from the intersected mesh
   - Map color → closest Minecraft block state using Euclidean RGB distance
5. Build `BlockGrid` from voxelized data
6. Convert to `SchematicData` via `gridToSchematic()`

### Color → Block Mapping

Uses nearest-neighbor search in RGB space:

```typescript
function colorToBlockState(r: number, g: number, b: number): string {
  let bestBlock = 'minecraft:stone';
  let bestDist = Infinity;
  for (const [block, [br, bg, bb]] of BLOCK_COLORS) {
    const dist = (r - br) ** 2 + (g - bg) ** 2 + (b - bb) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestBlock = block;
    }
  }
  return bestBlock;
}
```

### Raycasting Strategy

For each grid cell at position `(x, y, z)`:
1. Cast rays from +X, -X, +Y, -Y, +Z, -Z toward the cell center
2. If any ray intersects geometry within the cell bounds, mark as occupied
3. Use the material from the first intersection for color mapping

### Resolution

The `resolution` parameter controls voxel density:
- `resolution = 1`: 1 Three.js unit = 1 Minecraft block (default)
- `resolution = 2`: 0.5 units per block (2x detail)
- `resolution = 0.5`: 2 units per block (half detail)

## Limitations

- Non-cubic geometry is voxelized (detail may be lost)
- Only diffuse color is considered for block mapping
- Transparent/translucent materials are mapped to glass
- No support for block properties (stairs facing, slab type, etc.)
- Block entities are not generated from Three.js data
