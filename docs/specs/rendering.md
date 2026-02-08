# Rendering

## 2D PNG Rendering (`src/render/png-renderer.ts`)

### Image Generation

All renderers produce raw RGBA pixel buffers, then encode to PNG via:
1. **pureimage** (primary): Pure JS, works on all platforms
2. **sharp** (fallback): Faster native encoding if available

Maximum image dimension: 1950px (auto-scaled if exceeded).

### Floor Plan (`renderFloorDetail`)

Top-down view of a single story at configurable scale (default: 40px/block).

**Algorithm:**
1. For each (x, z) column in the story height range:
   - Scan Y layers top-to-bottom to find the first visible block
   - Classify as floor, ceiling, or content layer
   - Draw colored cell with 1px dark border
2. Overlay special markers:
   - Furniture: white square
   - Chests: yellow X
   - Lights: yellow filled circle
   - Beds: inner border highlight
   - Doors: vertical brown line
   - Valuable blocks: diamond outline
3. Draw 5-block grid overlay

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
3. For each visible block, draw 3 faces:
   - Top face: filled diamond (brighter, +35 RGB)
   - Left face: parallelogram (darker, -20 RGB)
   - Right face: parallelogram (darkest, -40 RGB)

**Options:** `tile` (iso tile size), `storyH`

### Exterior Isometric (`renderExterior`)

Full-building isometric view using same projection as cutaway but rendering all Y layers.

**Options:** `tile` (default: 8)

## 3D Rendering

### Scene Builder (`src/render/three-scene.ts`)

Builds a Three.js scene from a `BlockGrid`:

1. Iterate all non-air blocks
2. Skip fully occluded blocks (all 6 neighbors solid)
3. Group by material color using `InstancedMesh`
4. Apply `MeshStandardMaterial` (roughness: 0.8, metalness: 0.1)
5. Center model on X/Z axes

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
