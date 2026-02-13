# Rendering

## 2D PNG Rendering (`src/render/png-renderer.ts`)

### Image Generation

All renderers produce raw RGBA pixel buffers, then encode to PNG via:
1. **pureimage** (primary): Pure JS, works on all platforms
2. **sharp** (fallback): Faster native encoding if available

Maximum image dimension: 1950px (auto-scaled if exceeded).

### Texture Atlas (`src/render/texture-atlas.ts`)

`ProceduralAtlas` manages 230+ block textures at 32x32 resolution:
- **Real textures**: 334 Faithful 32x PNGs loaded from `textures/blocks/` via `initDefaultAtlas()`
- **Procedural fallback**: Generated patterns (brick, planks, stone, checker, cross, bookshelf, etc.)
- **Face mapping**: `getBlockTextures(blockState)` returns per-face texture names (top/bottom/N/S/E/W)
- **UV lookup**: `atlas.getUV(textureName)` for normalized coordinates, `.entries.get()` for raw RGBA data

### Item Sprites (`src/render/item-sprites.ts`)

17 hand-drawn 16x16 RGBA sprites for top-down furniture rendering:
flower pot, bed (colored), chair, table, lantern (warm/cool), chest, cauldron,
armor stand, bookshelf, brewing stand, enchanting table, bell, campfire, barrel,
anvil, crafting table, cartography table.

### Floor Plan (`renderFloorDetail`)

Top-down view of a single story at configurable scale (default: 40px/block).

**Algorithm:**
1. Initialize texture atlas via `ensureAtlas()` (cached)
2. For each (x, z) column in the story height range:
   - Scan Y layers top-to-bottom to find the first visible block
   - Look up block's top-face texture via `getBlockTextures(blockState).top`
   - If atlas has texture data: `blitTextureTile()` — nearest-neighbor scale 32x32 → cell size with tint
   - Otherwise: flat fill with `getBlockColor()`
   - Floor layer draws at 0.7 brightness tint
3. Overlay item sprites:
   - Look up `getItemSprite(baseId)` for furniture blocks
   - If sprite exists: `blitSprite()` — scale 16x16 sprite centered in cell
   - Otherwise: fall back to geometric markers (circles, X, diamonds)
4. Draw 5-block grid overlay

**Options:** `scale` (px/block), `storyH` (blocks per story)

### Cutaway Isometric (`renderCutawayIso`)

Isometric view of a single story slice showing interior detail.

**Projection (diamond/dimetric):**
```
screenX = (blockX - blockZ) * tile + centerX
screenY = -(blockY * tile) + (blockX + blockZ) * (tile / 2) + centerY
```

**Algorithm:**
1. Calculate image bounds from all 8 corner projections
2. Render in painter's order: Y ascending, Z descending, X ascending
3. For each visible block, draw 3 textured faces via `renderIsoBlock()`:
   - Top face: `blitTextureIsoTop()` — diamond shape, brightness ×1.15
   - Left face: `blitTextureIsoLeft()` — parallelogram, brightness ×0.85
   - Right face: `blitTextureIsoRight()` — parallelogram, brightness ×0.70
   - Per-face texture lookup: top → `.top`, left → `.west`, right → `.south`
   - Falls back to flat `getBlockColor()` tinted by face brightness

**Options:** `tile` (iso tile size), `storyH`

### Exterior Isometric (`renderExterior`)

Full-building isometric view using same projection and textured `renderIsoBlock()` as cutaway but rendering all Y layers.

**Options:** `tile` (default: 8)

## 3D Rendering

### Scene Builder (`web/src/viewer/scene.ts`)

Builds a Three.js scene from serialized block data:

1. Iterate all non-air blocks
2. Skip fully occluded blocks (all 6 neighbors solid)
3. Classify block geometry via `getGeometryKind()` — 10 shapes:
   - `cube` (1×1×1), `slab` (1×0.5×1), `carpet` (1×0.0625×1)
   - `fence` (0.25×1×0.25), `torch` (0.15×0.6×0.15), `lantern` (0.35×0.4×0.35)
   - `chain` (0.1×1×0.1), `door` (1×1×0.2), `pane` (0.1×1×1), `rod` (0.12×1×0.12)
4. Group by `color:blockName:geometryKind` → `InstancedMesh` per group
5. Load textures via `loadBlockTexture()`:
   - Tries real Faithful 32x PNG from bundled `textures/blocks/*.png` (Vite import.meta.glob)
   - Falls back to procedural canvas texture (32×32)
   - `NearestFilter` for crisp pixel-art appearance
6. Emissive glow for light-emitting blocks (lanterns, glowstone, sea_lantern, etc.)
7. Directional rotation for facing-sensitive blocks (doors, panes)
8. Center model on X/Z axes

### Viewer Serialization

`serializeForViewer()` produces a JSON object for the browser:
```json
{
  "width": 35,
  "height": 20,
  "length": 30,
  "blockCount": 4442,
  "blocks": [
    { "x": 0, "y": 0, "z": 0, "color": [200, 200, 200] },
    ...
  ]
}
```

### Dev Server (`src/render/server.ts`)

Express server serving:
- `GET /` — Self-contained HTML viewer page
- `GET /api/schematic` — JSON block data

### HTML Viewer

Self-contained single HTML page with:
- Three.js and OrbitControls loaded from CDN via importmap
- Scene data embedded as JSON in `<script>` tag
- Ambient + directional + hemisphere lighting
- Fog for depth perception
- Dark background (`#1a1a2e`)
- Responsive canvas with resize handling
- Info overlay (dimensions, block count)
- Controls: drag to rotate, scroll to zoom, right-drag to pan

### HTML Export (`src/render/export-html.ts`)

Generates the same viewer HTML as a standalone file — no server needed. The schematic data is embedded directly in the HTML.
