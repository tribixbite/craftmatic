# craftmatic

Minecraft schematic toolkit — parse, generate, render, and convert `.schem` files.

## Features

- **Parse & Write** Sponge Schematic v2 (`.schem`) files
- **Generate** structures with 5 style presets and 16 room types
- **Render** 2D PNG floor plans, cutaway isometrics, and exterior views
- **View** schematics in an interactive 3D viewer (Three.js)
- **Export** standalone HTML viewers
- **Convert** between Three.js scenes and `.schem` format
- Works as both a **library** and **CLI tool**

## Install

```bash
npm install craftmatic
```

## CLI

```bash
# Print schematic info
npx craftmatic info building.schem

# Render 2D PNGs (floor plans, cutaways, exterior)
npx craftmatic render building.schem

# Open interactive 3D viewer
npx craftmatic view building.schem

# Export standalone HTML viewer
npx craftmatic export building.schem viewer.html

# Generate a structure
npx craftmatic gen house --floors 3 --style fantasy --seed 42
```

### Generation Options

```
npx craftmatic gen [type] [options]

Types: house, tower, castle, dungeon, ship

Options:
  -f, --floors <n>     Number of floors (default: 2)
  -s, --style <style>  Building style (default: fantasy)
  -r, --rooms <list>   Comma-separated room list
  -w, --width <n>      Building width
  -l, --length <n>     Building length
  -o, --output <path>  Output file path
  --seed <n>           Random seed
```

### Styles

`fantasy` | `medieval` | `modern` | `gothic` | `rustic`

### Room Types

`living` `dining` `kitchen` `foyer` `bedroom` `bathroom` `study` `library` `vault` `armory` `observatory` `lab` `gallery` `throne` `forge` `greenhouse`

## Library API

```typescript
import {
  parseSchematic,
  parseToGrid,
  writeSchematic,
  generateStructure,
  renderFloorDetail,
  renderCutawayIso,
  renderExterior,
  exportHTML,
  schemToThree,
  threeToSchem,
} from 'craftmatic';

// Parse a schematic
const data = await parseSchematic('building.schem');
const grid = await parseToGrid('building.schem');

// Generate a structure
const house = generateStructure({
  type: 'house',
  floors: 3,
  style: 'fantasy',
  rooms: ['vault', 'observatory', 'lab'],
  seed: 42,
});

// Write to .schem
writeSchematic(house, 'output.schem');

// Render 2D PNGs
const floorPng = await renderFloorDetail(grid, 0, { scale: 40 });
const cutawayPng = await renderCutawayIso(grid, 0, { tile: 12 });
const exteriorPng = await renderExterior(grid, { tile: 8 });

// Export HTML viewer
exportHTML(grid, 'viewer.html');

// Convert to Three.js
const threeGroup = schemToThree(data);

// Convert Three.js back to schematic
const schemData = threeToSchem(threeGroup);
```

## Development

```bash
git clone https://github.com/tribixbite/craftmatic.git
cd craftmatic
npm install
npm run build
npm run typecheck
```

## License

MIT
