/**
 * Main structure generation orchestrator.
 * Coordinates structural elements and room placement to generate
 * complete buildings from parameters. Supports house, tower, castle,
 * dungeon, and ship structure types with distinct layouts.
 */

import { BlockGrid } from '../schem/types.js';
import type { GenerationOptions, StructureType } from '../types/index.js';
import { getStyle } from './styles.js';
import type { StylePalette } from './styles.js';
import { createRng, STORY_H, ROOF_H, trimGrid, pasteGrid, pick, stampSign } from './gen-utils.js';
import { generateHouse } from './gen-house.js';
import {
  generateTower, generateCastle, generateDungeon, generateShip,
  generateCathedral, generateBridge, generateWindmill,
  generateMarketplace, generateVillage,
} from './gen-structures.js';

/**
 * Expand a building grid into a compound site with real companion buildings.
 * Uses the actual generator functions (generateHouse, generateTower) to create
 * substantial secondary structures — the same approach the Village generator uses.
 * No rectangular perimeter fences; just buildings, paths, and environmental elements.
 */
function compoundify(
  buildingGrid: BlockGrid, type: StructureType, style: StylePalette, rng: () => number,
  styleName?: string
): BlockGrid {
  // Already-compound types don't need expansion
  if (type === 'village' || type === 'marketplace') return buildingGrid;

  // Generous expansion: 30 blocks per axis (15 on each side)
  const expansion = 30;
  const halfExp = Math.floor(expansion / 2);
  const gw = buildingGrid.width + expansion;
  const gl = buildingGrid.length + expansion;
  const gh = Math.max(buildingGrid.height, STORY_H * 2 + ROOF_H);

  const compound = new BlockGrid(gw, gh, gl);

  // Paste original building centered in compound
  pasteGrid(compound, buildingGrid, halfExp, 0, halfExp);

  // Building footprint bounds in compound coordinates
  const bx1 = halfExp;
  const bz1 = halfExp;
  const bx2 = halfExp + buildingGrid.width - 1;
  const bz2 = halfExp + buildingGrid.length - 1;
  const bxMid = Math.floor((bx1 + bx2) / 2);
  const bzMid = Math.floor((bz1 + bz2) / 2);

  // Helper: generate a real companion building and paste it at position.
  // 2-story companions create taller silhouettes that are visible at thumbnail scale.
  const placeCompanionHouse = (ox: number, oz: number, w: number, l: number, floors = 2) => {
    const sub = generateHouse(floors, style, undefined, w, l, rng);
    pasteGrid(compound, sub, ox, 0, oz);
    return sub;
  };

  // Helper: draw a 3-wide cobblestone path between two points (L-shaped)
  const connectPath = (x1: number, z1: number, x2: number, z2: number, block = 'minecraft:cobblestone') => {
    // Horizontal segment
    const xMin = Math.min(x1, x2);
    const xMax = Math.max(x1, x2);
    for (let x = xMin; x <= xMax; x++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (compound.inBounds(x, 0, z1 + dz))
          compound.set(x, 0, z1 + dz, block);
      }
    }
    // Vertical segment
    const zMin = Math.min(z1, z2);
    const zMax = Math.max(z1, z2);
    for (let z = zMin; z <= zMax; z++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (compound.inBounds(x2 + dx, 0, z))
          compound.set(x2 + dx, 0, z, block);
      }
    }
  };

  // ── Type-specific compound compositions ─────────────────────────────

  if (type === 'house' && styleName === 'modern') {
    // Modern house: pool + glass-walled garage — geometric variety, not just more white boxes
    // West: garage/carport (dark concrete for contrast, 1 story)
    const garageStyle = { ...style, wall: 'minecraft:gray_concrete', wallAccent: 'minecraft:black_concrete' };
    const garageSub = generateHouse(1, garageStyle, undefined, 16, 12, rng);
    pasteGrid(compound, garageSub, 0, 0, bz1);
    // East: guest pavilion with glass walls (2 stories, light blue accent)
    const pavStyle = { ...style, wall: 'minecraft:light_gray_concrete', window: 'minecraft:light_blue_stained_glass_pane' };
    const pavSub = generateHouse(2, pavStyle, undefined, 18, 14, rng);
    pasteGrid(compound, pavSub, bx2 + 2, 0, bz1 + 2);
    // South: swimming pool (10x6 water rectangle with quartz border)
    const poolZ = bz2 + 3;
    const poolX = bxMid - 5;
    for (let x = poolX; x < poolX + 10 && x < gw; x++) {
      for (let z = poolZ; z < poolZ + 6 && z < gl; z++) {
        if (!compound.inBounds(x, 0, z)) continue;
        const isEdge = x === poolX || x === poolX + 9 || z === poolZ || z === poolZ + 5;
        compound.set(x, 0, z, isEdge ? 'minecraft:smooth_quartz' : 'minecraft:water');
        if (isEdge && compound.inBounds(x, 1, z))
          compound.set(x, 1, z, 'minecraft:smooth_quartz_slab[type=bottom]');
      }
    }
    // Paths
    connectPath(bx1, bzMid, 0, bzMid, 'minecraft:smooth_quartz');
    connectPath(bx2, bzMid, bx2 + 2, bzMid, 'minecraft:smooth_quartz');
    connectPath(bxMid, bz2, bxMid, poolZ, 'minecraft:smooth_quartz');

  } else if (type === 'house') {
    // Non-modern house: workshop + guest house + garden cottage
    placeCompanionHouse(0, bz1, 20, 15);
    const ehX = bx2 + 2;
    placeCompanionHouse(ehX, bz1 + 2, 18, 14);
    const gcZ = bz2 + 3;
    if (compound.inBounds(bxMid + 8, 0, gcZ + 18))
      placeCompanionHouse(bxMid - 8, gcZ, 16, 12, 1);
    connectPath(bx1, bzMid, 0, bzMid);
    connectPath(bx2, bzMid, ehX, bzMid);
    connectPath(bxMid, bz2, bxMid, gcZ);
    const flowers = ['minecraft:rose_bush', 'minecraft:lilac', 'minecraft:peony', 'minecraft:sunflower'];
    for (let x = bxMid - 5; x <= bxMid + 5 && x < gw; x++) {
      for (let z = bz2 + 1; z < gcZ && z < gl; z++) {
        if (compound.inBounds(x, 0, z) && compound.get(x, 0, z) === 'minecraft:air') {
          compound.set(x, 0, z, 'minecraft:grass_block');
          if (rng() < 0.5 && compound.inBounds(x, 1, z))
            compound.set(x, 1, z, pick(flowers, rng));
        }
      }
    }

  } else if (type === 'tower') {
    // West: library/study (18x14, 2 stories)
    placeCompanionHouse(0, bzMid - 7, 18, 14);
    // East: guard barracks (18x14, 2 stories)
    placeCompanionHouse(bx2 + 2, bzMid - 7, 18, 14);
    // South: armory (16x12, 1 story)
    const armZ = bz2 + 3;
    if (compound.inBounds(bxMid + 8, 0, armZ + 18))
      placeCompanionHouse(bxMid - 8, armZ, 16, 12, 1);
    // Paths
    connectPath(bx1, bzMid, 0, bzMid);
    connectPath(bx2, bzMid, bx2 + 2, bzMid);
    connectPath(bxMid, bz2, bxMid, armZ);

  } else if (type === 'castle') {
    // West: stable house (20x16, 2 stories)
    placeCompanionHouse(0, bzMid - 8, 20, 16);
    // East: armory/barracks (20x16, 2 stories)
    placeCompanionHouse(bx2 + 2, bzMid - 8, 20, 16);
    // South: chapel (18x14, 2 stories)
    const chapelX = bxMid - 9;
    const chapelZ = bz2 + 3;
    if (compound.inBounds(chapelX + 24, 0, chapelZ + 20))
      placeCompanionHouse(chapelX, chapelZ, 18, 14);
    // Stone paths connecting
    connectPath(bx1, bzMid, 0, bzMid, 'minecraft:stone_bricks');
    connectPath(bx2, bzMid, bx2 + 2, bzMid, 'minecraft:stone_bricks');
    connectPath(bxMid, bz2, bxMid, chapelZ, 'minecraft:stone_bricks');

  } else if (type === 'dungeon') {
    // Excavation site: gatehouse entrance, large watchtower, crumbling perimeter, scaffolding
    // West: gatehouse (intact 2-story building — the expedition's base)
    placeCompanionHouse(0, bzMid - 7, 18, 14);
    // East: large watchtower (6x6, 12 tall with battlements — visual anchor)
    const wtX = bx2 + 4;
    const wtZ = bzMid - 3;
    const wtH = 12;
    for (let y = 0; y <= wtH; y++) {
      for (let dx = 0; dx < 6; dx++) {
        for (let dz = 0; dz < 6; dz++) {
          if (dx === 0 || dx === 5 || dz === 0 || dz === 5) {
            if (compound.inBounds(wtX + dx, y, wtZ + dz))
              compound.set(wtX + dx, y, wtZ + dz, y === 0 ? style.foundation : 'minecraft:mossy_stone_bricks');
          }
        }
      }
    }
    // Watchtower battlements
    for (let dx = 0; dx < 6; dx++) {
      for (let dz = 0; dz < 6; dz++) {
        if ((dx === 0 || dx === 5 || dz === 0 || dz === 5) && (dx + dz) % 2 === 0) {
          if (compound.inBounds(wtX + dx, wtH + 1, wtZ + dz))
            compound.set(wtX + dx, wtH + 1, wtZ + dz, 'minecraft:mossy_stone_bricks');
        }
      }
    }
    // Watchtower interior torches
    if (compound.inBounds(wtX + 1, 2, wtZ + 1)) compound.set(wtX + 1, 2, wtZ + 1, 'minecraft:lantern');
    // Crumbling perimeter walls (L-shape, weathered)
    const wallBlk = 'minecraft:cobblestone_wall';
    const mossBlk = 'minecraft:mossy_cobblestone_wall';
    // North wall (partial)
    for (let x = bx1 - 3; x < bx2 + 3 && x < gw; x++) {
      if (compound.inBounds(x, 1, bz1 - 2) && rng() < 0.7)
        compound.set(x, 1, bz1 - 2, rng() < 0.5 ? wallBlk : mossBlk);
    }
    // South wall (partial)
    for (let x = bx1 - 3; x < bx2 + 3 && x < gw; x++) {
      if (compound.inBounds(x, 1, bz2 + 2) && rng() < 0.7)
        compound.set(x, 1, bz2 + 2, rng() < 0.5 ? wallBlk : mossBlk);
    }
    // Wooden scaffolding near dungeon entrance (3 tall, A-frame)
    const scX = bxMid + 3;
    const scZ = bz1 - 1;
    for (let y = 1; y <= 4; y++) {
      if (compound.inBounds(scX, y, scZ)) compound.set(scX, y, scZ, 'minecraft:oak_fence');
      if (compound.inBounds(scX + 2, y, scZ)) compound.set(scX + 2, y, scZ, 'minecraft:oak_fence');
    }
    // Scaffolding crossbar
    for (let dx = 0; dx <= 2; dx++) {
      if (compound.inBounds(scX + dx, 4, scZ)) compound.set(scX + dx, 4, scZ, 'minecraft:oak_planks');
    }
    // Organized graveyard rows (south of dungeon)
    const gyZ = bz2 + 4;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 6; col++) {
        const gx = bxMid - 5 + col * 2;
        const gz = gyZ + row * 2;
        if (compound.inBounds(gx, 0, gz)) {
          compound.set(gx, 0, gz, 'minecraft:podzol');
          if (compound.inBounds(gx, 1, gz)) compound.set(gx, 1, gz, 'minecraft:cobblestone_wall');
        }
      }
    }
    // Gravel paths connecting all elements
    connectPath(bx1, bzMid, 0, bzMid, 'minecraft:gravel');
    connectPath(bx2, bzMid, wtX, bzMid, 'minecraft:gravel');
    connectPath(bxMid, bz2, bxMid, gyZ, 'minecraft:gravel');
    // Dead trees for atmosphere
    for (let i = 0; i < 5; i++) {
      const tx = Math.floor(rng() * (gw - 4)) + 2;
      const tz = Math.floor(rng() * (gl - 4)) + 2;
      const treeH = 3 + Math.floor(rng() * 4);
      for (let y = 0; y < treeH; y++) {
        if (compound.inBounds(tx, y + 1, tz) && compound.get(tx, y + 1, tz) === 'minecraft:air')
          compound.set(tx, y + 1, tz, 'minecraft:spruce_log');
      }
    }

  } else if (type === 'ship') {
    // Harbor: warehouse building south (20x16, 2 stories)
    const whZ = bz2 + 4;
    if (compound.inBounds(bxMid + 10, 0, whZ + 22))
      placeCompanionHouse(bxMid - 10, whZ, 20, 16);
    // Harbor master office west (18x14, 2 stories)
    placeCompanionHouse(0, bzMid - 7, 18, 14);
    // Dock platform connecting ship to harbor (timber)
    for (let x = bx1; x <= bx2 && x < gw; x++) {
      for (let z = bz2 + 1; z < whZ && z < gl; z++) {
        if (compound.inBounds(x, 2, z) && compound.get(x, 2, z) === 'minecraft:air') {
          compound.set(x, 2, z, 'minecraft:spruce_planks');
          if (compound.get(x, 1, z) === 'minecraft:air')
            compound.set(x, 1, z, 'minecraft:spruce_fence');
        }
      }
    }
    // Paths
    connectPath(bxMid, bz2 + 3, bxMid, whZ, 'minecraft:spruce_planks');

  } else if (type === 'cathedral') {
    // Staggered companions at different Z for depth — breaks monolithic side profile
    // West: parish house (20x16, 2 stories, offset north for depth)
    placeCompanionHouse(0, bz1, 20, 16);
    // East: chapter house (18x14, 2 stories, offset south for depth)
    placeCompanionHouse(bx2 + 2, bz2 - 14, 18, 14);
    // South: bell tower (6x6, 10 tall — tall narrow structure for visual interest)
    const btX = bxMid - 3;
    const btZ = bz2 + 4;
    for (let y = 0; y <= 10; y++) {
      for (let dx = 0; dx < 6; dx++) {
        for (let dz = 0; dz < 6; dz++) {
          if (dx === 0 || dx === 5 || dz === 0 || dz === 5 || y === 0) {
            if (compound.inBounds(btX + dx, y, btZ + dz))
              compound.set(btX + dx, y, btZ + dz, y === 0 ? style.foundation : style.wall);
          }
        }
      }
    }
    // Bell tower cap (pyramid)
    for (let dy = 0; dy < 3; dy++) {
      const inset = dy;
      for (let dx = inset; dx < 6 - inset; dx++) {
        for (let dz = inset; dz < 6 - inset; dz++) {
          if (compound.inBounds(btX + dx, 11 + dy, btZ + dz))
            compound.set(btX + dx, 11 + dy, btZ + dz, style.roofCap);
        }
      }
    }
    // Stone cloister paths
    connectPath(bx1, bzMid, 0, bzMid, 'minecraft:stone_bricks');
    connectPath(bx2, bzMid, bx2 + 2, bzMid, 'minecraft:stone_bricks');
    connectPath(bxMid, bz2, bxMid, btZ, 'minecraft:stone_bricks');
    // Graveyard between bell tower and main
    const gyZ = bz2 + 2;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 6; col++) {
        const gx = bxMid - 5 + col * 2;
        const gz = gyZ + row * 2 + 8;
        if (compound.inBounds(gx, 0, gz)) {
          compound.set(gx, 0, gz, 'minecraft:podzol');
          if (compound.inBounds(gx, 1, gz))
            compound.set(gx, 1, gz, 'minecraft:cobblestone_wall');
        }
      }
    }

  } else if (type === 'bridge') {
    // Gatehouse towers: tall narrow buildings straddling each bridge end
    // South gatehouse (12x10, 3 stories — tall and narrow)
    const thZ = bz2 + 2;
    if (compound.inBounds(bxMid + 6, 0, thZ + 16))
      placeCompanionHouse(bxMid - 6, thZ, 12, 10, 3);
    // North gatehouse (12x10, 3 stories)
    placeCompanionHouse(bxMid - 6, 0, 12, 10, 3);
    // Guard tower east of south gate (5x5, 10 tall — visual anchor)
    const gtX = bxMid + 8;
    const gtZ = thZ + 2;
    for (let y = 0; y <= 10; y++) {
      for (let dx = 0; dx < 5; dx++) {
        for (let dz = 0; dz < 5; dz++) {
          if (dx === 0 || dx === 4 || dz === 0 || dz === 4 || y === 0) {
            if (compound.inBounds(gtX + dx, y, gtZ + dz))
              compound.set(gtX + dx, y, gtZ + dz, y === 0 ? style.foundation : style.wall);
          }
        }
      }
    }
    // Guard tower battlements
    for (let dx = 0; dx < 5; dx++) {
      for (let dz = 0; dz < 5; dz++) {
        if ((dx === 0 || dx === 4 || dz === 0 || dz === 4) && (dx + dz) % 2 === 0) {
          if (compound.inBounds(gtX + dx, 11, gtZ + dz))
            compound.set(gtX + dx, 11, gtZ + dz, style.wall);
        }
      }
    }
    // Paths connecting gates to bridge
    connectPath(bxMid, bz2, bxMid, thZ, 'minecraft:cobblestone');
    connectPath(bxMid, bz1, bxMid, 16, 'minecraft:cobblestone');

  } else if (type === 'windmill') {
    // West: grain barn (20x15, 2 stories)
    placeCompanionHouse(0, bzMid - 7, 20, 15);
    // East: farmer's cottage (18x14, 2 stories)
    placeCompanionHouse(bx2 + 2, bzMid - 7, 18, 14);
    // Paths
    connectPath(bx1, bzMid, 0, bzMid);
    connectPath(bx2, bzMid, bx2 + 2, bzMid);
    // Wheat field south (large, no fence — just crops)
    const fieldZ = bz2 + 2;
    for (let x = 3; x < gw - 3; x++) {
      for (let z = fieldZ; z < Math.min(fieldZ + 10, gl - 1); z++) {
        if (compound.inBounds(x, 0, z) && compound.get(x, 0, z) === 'minecraft:air') {
          compound.set(x, 0, z, 'minecraft:farmland[moisture=7]');
          if (compound.inBounds(x, 1, z))
            compound.set(x, 1, z, 'minecraft:wheat[age=7]');
        }
      }
    }
  }

  // Trim to occupied bounding box so the thumbnail renderer gets tighter tile sizes
  return trimGrid(compound, 2);
}

/**
 * Generate a complete structure from parameters.
 * Returns a populated BlockGrid ready for schematic export.
 */
export function generateStructure(options: GenerationOptions): BlockGrid {
  const {
    type = 'house',
    floors = 2,
    style: styleName = 'fantasy',
    rooms,
    width,
    length,
    seed = Date.now(),
  } = options;

  const rng = createRng(seed);
  const style = { ...getStyle(styleName) };

  // Apply color overrides from options
  if (options.wallOverride) {
    style.wall = options.wallOverride;
    style.interiorWall = options.wallOverride;
  }
  if (options.trimOverride) {
    style.wallAccent = options.trimOverride;
    style.pillar = options.trimOverride;
    style.timber = options.trimOverride;
    // Derive axis-specific timber variants with axis property
    const base = options.trimOverride.replace(/\[.*\]$/, '');
    style.timberX = base.includes('log') ? `${base}[axis=x]` : options.trimOverride;
    style.timberZ = base.includes('log') ? `${base}[axis=z]` : options.trimOverride;
  }
  if (options.doorOverride) {
    const wood = options.doorOverride;
    const prefix = wood === 'iron' ? 'minecraft:iron_door' : `minecraft:${wood}_door`;
    style.doorLowerN = `${prefix}[facing=north,half=lower,hinge=left,open=false]`;
    style.doorUpperN = `${prefix}[facing=north,half=upper,hinge=left,open=false]`;
    style.doorLowerS = `${prefix}[facing=south,half=lower,hinge=left,open=false]`;
    style.doorUpperS = `${prefix}[facing=south,half=upper,hinge=left,open=false]`;
  }
  if (options.roofOverride) {
    style.roofN = options.roofOverride.north;
    style.roofS = options.roofOverride.south;
    style.roofCap = options.roofOverride.cap;
  }

  let grid: BlockGrid;
  switch (type) {
    case 'tower':
      grid = generateTower(floors, style, rooms, width, length, rng);
      break;
    case 'castle':
      grid = generateCastle(floors, style, rooms, width, length, rng);
      break;
    case 'dungeon':
      grid = generateDungeon(floors, style, rooms, width, length, rng);
      break;
    case 'ship':
      grid = generateShip(floors, style, rooms, width, length, rng);
      break;
    case 'cathedral':
      grid = generateCathedral(floors, style, rooms, width, length, rng);
      break;
    case 'bridge':
      grid = generateBridge(floors, style, rooms, width, length, rng);
      break;
    case 'windmill':
      grid = generateWindmill(floors, style, rooms, width, length, rng);
      break;
    case 'marketplace':
      grid = generateMarketplace(floors, style, rooms, width, length, rng);
      break;
    case 'village':
      grid = generateVillage(floors, style, rooms, width, length, rng);
      break;
    case 'house':
    default:
      grid = generateHouse(floors, style, rooms, width, length, rng, options.roofShape, options.features, options.floorPlanShape);
      break;
  }

  // Expand single-building grids into compound sites with companion structures
  grid = compoundify(grid, type, style, rng, styleName);

  // Add ground plane — grass for land structures, water for ships/bridges
  // Village already has its own grass layer, skip it
  if (type !== 'village') {
    const isWaterType = type === 'ship' || type === 'bridge';
    const groundBlock = isWaterType ? 'minecraft:water' : 'minecraft:grass_block';
    // Ships get a waterline at ~40% hull depth so they look immersed
    const waterHeight = isWaterType ? 2 : 0;
    for (let x = 0; x < grid.width; x++) {
      for (let z = 0; z < grid.length; z++) {
        for (let y = 0; y <= waterHeight; y++) {
          if (grid.get(x, y, z) === 'minecraft:air') {
            grid.set(x, y, z, groundBlock);
          }
        }
      }
    }
  }

  // Stamp a wall sign with version, mint date, and structure metadata
  stampSign(grid, type, styleName, floors, options.seed);

  return grid;
}
