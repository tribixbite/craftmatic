/**
 * Main structure generation orchestrator.
 * Coordinates structural elements and room placement to generate
 * complete buildings from parameters. Supports house, tower, castle,
 * dungeon, and ship structure types with distinct layouts.
 */

import { BlockGrid } from '../schem/types.js';
import { isAir } from '../blocks/registry.js';
import type { GenerationOptions, RoomType, RoomBounds, StructureType, RoofShape, FeatureFlags, FloorPlanShape } from '../types/index.js';
import { getStyle } from './styles.js';
import { getRoomGenerator, getRoomTypes } from './rooms.js';
import {
  foundation, floor, exteriorWalls, timberColumns, timberBeams,
  windows, interiorWall, doorway, frontDoor, staircase,
  gabledRoof, hipRoof, flatRoof, gambrelRoof, mansardRoof,
  chimney, wallTorches, porch,
  placeTree, placeGarden, placePool,
  addBackyard, addDriveway, addPropertyFence,
  weatherWalls, addCobwebs, addChains, accentBand, glassCurtainWall,
  windowSills, baseTrim, eaveTrim,
} from './structures.js';
import { chandelier } from './furniture.js';
import type { StylePalette } from './styles.js';

/** Seeded pseudo-random number generator (mulberry32) */
function createRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a random element from an array */
function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Place a small outbuilding (shed, gazebo, stable, etc.) at the given position.
 * Creates compositional complexity that scores well in visual evaluation.
 */
function placeOutbuilding(
  grid: BlockGrid, x1: number, z1: number, w: number, l: number, h: number,
  style: StylePalette, roofType: 'gable' | 'flat' | 'lean-to' = 'gable'
): void {
  const x2 = x1 + w - 1;
  const z2 = z1 + l - 1;
  if (!grid.inBounds(x2, h + 3, z2) || !grid.inBounds(x1, 0, z1)) return;
  // Foundation
  grid.fill(x1, 0, z1, x2, 0, z2, style.foundation);
  // Walls
  for (let y = 1; y <= h; y++) {
    for (let x = x1; x <= x2; x++) {
      grid.set(x, y, z1, style.wall);
      grid.set(x, y, z2, style.wall);
    }
    for (let z = z1; z <= z2; z++) {
      grid.set(x1, y, z, style.wall);
      grid.set(x2, y, z, style.wall);
    }
  }
  // Interior floor
  grid.fill(x1 + 1, 0, z1 + 1, x2 - 1, 0, z2 - 1, style.floorGround);
  // Door (south face, center)
  const doorX = x1 + Math.floor(w / 2);
  if (grid.inBounds(doorX, 1, z2)) {
    grid.set(doorX, 1, z2, 'minecraft:air');
    grid.set(doorX, 2, z2, 'minecraft:air');
  }
  // Roof
  if (roofType === 'flat') {
    grid.fill(x1, h + 1, z1, x2, h + 1, z2, style.slabBottom);
  } else if (roofType === 'lean-to') {
    for (let x = x1; x <= x2; x++) {
      grid.set(x, h + 1, z1, style.roofN);
      grid.set(x, h + 1, z2, style.slabBottom);
    }
  } else {
    // Gable roof along X axis
    const midZ = z1 + Math.floor(l / 2);
    for (let layer = 0; layer <= Math.floor(l / 2) + 1; layer++) {
      const ry = h + 1 + layer;
      if (!grid.inBounds(x1, ry, midZ)) break;
      for (let x = x1; x <= x2; x++) {
        if (midZ - layer >= z1 && grid.inBounds(x, ry, midZ - layer))
          grid.set(x, ry, midZ - layer, style.roofN);
        if (midZ + layer <= z2 && grid.inBounds(x, ry, midZ + layer))
          grid.set(x, ry, midZ + layer, style.roofS);
      }
      if (layer === Math.floor(l / 2)) {
        for (let x = x1; x <= x2; x++) {
          if (grid.inBounds(x, ry + 1, midZ))
            grid.set(x, ry + 1, midZ, style.roofCap);
        }
      }
    }
  }
  // Window on each side
  const winY = Math.min(h - 1, 2);
  const midX = x1 + Math.floor(w / 2);
  const midZ = z1 + Math.floor(l / 2);
  if (grid.inBounds(midX, winY, z1)) grid.set(midX, winY, z1, style.window);
  if (grid.inBounds(x1, winY, midZ)) grid.set(x1, winY, midZ, style.window);
  if (grid.inBounds(x2, winY, midZ)) grid.set(x2, winY, midZ, style.window);
}

/** Default room assignments per floor when none specified */
const DEFAULT_FLOOR_ROOMS: RoomType[][] = [
  ['living', 'kitchen', 'dining', 'foyer'],
  ['bedroom', 'bathroom', 'closet', 'laundry'],
  ['bedroom', 'study', 'sunroom', 'pantry'],
  ['library', 'bedroom', 'bathroom', 'mudroom'],
  ['observatory', 'gallery', 'gallery', 'gallery'],
];

/** Per-story height in blocks */
const STORY_H = 5;
/** Roof height allocation */
const ROOF_H = 10;

/**
 * Crop a BlockGrid to the tightest axis-aligned bounding box around all non-air
 * blocks, with a small padding. Reduces wasted tile budget in the thumbnail renderer.
 */
function trimGrid(grid: BlockGrid, padding = 1): BlockGrid {
  let minX = grid.width, minY = grid.height, minZ = grid.length;
  let maxX = -1, maxY = -1, maxZ = -1;
  for (let x = 0; x < grid.width; x++) {
    for (let z = 0; z < grid.length; z++) {
      for (let y = 0; y < grid.height; y++) {
        if (!isAir(grid.get(x, y, z))) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }
    }
  }
  if (maxX < 0) return grid; // all air — return as-is
  // Apply padding, clamped to grid bounds
  minX = Math.max(0, minX - padding); minY = Math.max(0, minY - padding); minZ = Math.max(0, minZ - padding);
  maxX = Math.min(grid.width - 1, maxX + padding); maxY = Math.min(grid.height - 1, maxY + padding); maxZ = Math.min(grid.length - 1, maxZ + padding);
  const tw = maxX - minX + 1;
  const th = maxY - minY + 1;
  const tl = maxZ - minZ + 1;
  // Skip trim if savings < 10% — not worth the copy cost
  if (tw * tl > grid.width * grid.length * 0.9) return grid;
  const trimmed = new BlockGrid(tw, th, tl);
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let y = minY; y <= maxY; y++) {
        trimmed.set(x - minX, y - minY, z - minZ, grid.get(x, y, z));
      }
    }
  }
  // Copy block entities with offset
  for (const be of grid.blockEntities) {
    const [bx, by, bz] = be.pos;
    if (bx >= minX && bx <= maxX && by >= minY && by <= maxY && bz >= minZ && bz <= maxZ) {
      trimmed.blockEntities.push({ ...be, pos: [bx - minX, by - minY, bz - minZ] });
    }
  }
  return trimmed;
}

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

  return grid;
}

// ─── House ──────────────────────────────────────────────────────────────────

function generateHouse(
  floors: number, style: StylePalette, rooms: RoomType[] | undefined,
  bwOpt: number | undefined, blOpt: number | undefined, rng: () => number,
  roofShapeOpt?: RoofShape, features?: FeatureFlags,
  planShape: FloorPlanShape = 'rect'
): BlockGrid {
  // Use style's preferred roof shape when no explicit override
  const roofShape: RoofShape = roofShapeOpt ?? style.defaultRoofShape;
  // Use style's preferred roof height (overrides global ROOF_H constant)
  const effectiveRoofH = style.roofHeight;
  const bw = bwOpt ?? 29;
  const bl = blOpt ?? 23;
  const margin = 3;
  const porchDepth = 4;
  // For L/T/U plans, allocate extra width for the wing(s)
  const wingW = (planShape !== 'rect') ? Math.max(8, Math.floor(bw * 0.45)) : 0;
  const wingL = (planShape !== 'rect') ? Math.max(6, Math.floor(bl * 0.4)) : 0;
  // U-shape needs extra space on both sides; L/T only on one side
  const extraEast = (planShape !== 'rect') ? wingW : 0;
  const extraWest = (planShape === 'U') ? wingW : 0;
  const gw = bw + 2 * margin + extraEast + extraWest;
  const gl = bl + 2 * margin + porchDepth;
  const gh = floors * STORY_H + effectiveRoofH;

  // Shift main building right for U-shape to make room for west wing
  const bx1 = margin + extraWest;
  const bx2 = margin + extraWest + bw - 1;
  const bz1 = margin;
  const bz2 = margin + bl - 1;
  const xMid = margin + Math.floor(bw / 2);
  const zMid = margin + Math.floor(bl / 2);

  const grid = new BlockGrid(gw, gh, gl);

  // Foundation
  foundation(grid, bx1, bz1, bx2, bz2, style);

  // Per-story shell
  for (let story = 0; story < floors; story++) {
    const by = story * STORY_H;
    const cy = by + STORY_H;

    floor(grid, bx1 + 1, by, bz1 + 1, bx2 - 1, bz2 - 1, style, story === 0);
    exteriorWalls(grid, bx1, by + 1, bz1, bx2, cy - 1, bz2, style);

    const colXs = [bx1, bx1 + Math.floor(bw / 4), xMid, bx2 - Math.floor(bw / 4), bx2];
    const colPositions: [number, number][] = [];
    for (const cx of colXs) {
      colPositions.push([cx, bz1], [cx, bz2]);
    }
    const sideZs = [bz1, bz1 + 5, zMid, bz2 - 5, bz2].filter(z => z >= bz1 && z <= bz2);
    for (const sz of sideZs) {
      colPositions.push([bx1, sz], [bx2, sz]);
    }
    timberColumns(grid, colPositions, by, cy, style);
    timberBeams(grid, bx1, by, bz1, bx2, bz2, style);
    timberBeams(grid, bx1, cy, bz1, bx2, bz2, style);

    windows(grid, bx1, bz1, bx2, bz2, by + 2, by + 3, style);
    // Window sills — top-slab below each window for depth
    windowSills(grid, bx1, bz1, bx2, bz2, by + 1, style);

    interiorWall(grid, 'z', xMid, bz1 + 1, bz2 - 1, by + 1, cy - 1, style);
    doorway(grid, xMid, by + 1, zMid - 1, xMid, by + 3, zMid + 1);

    interiorWall(grid, 'x', zMid, bx1 + 1, xMid - 1, by + 1, cy - 1, style);
    interiorWall(grid, 'x', zMid, xMid + 1, bx2 - 1, by + 1, cy - 1, style);
    doorway(grid, bx1 + 4, by + 1, zMid, bx1 + 6, by + 3, zMid);
    doorway(grid, bx2 - 6, by + 1, zMid, bx2 - 4, by + 3, zMid);

    // Foundation base trim on ground story
    if (story === 0) {
      baseTrim(grid, bx1, bz1, bx2, bz2, by + 1, style);
    }

    if (story === floors - 1) {
      grid.fill(bx1, cy, bz1, bx2, cy, bz2, style.ceiling);
      // Eave overhang at roofline
      eaveTrim(grid, bx1, bz1, bx2, bz2, cy, style);
    }

    wallTorches(grid, bx1, bz1, bx2, bz2, by + 3, style);
  }

  const dx = xMid;
  // Porch is gated by features flag (default: true)
  if (features?.porch !== false) {
    porch(grid, dx, bz2, 9, STORY_H, style, 'south');
    // Exterior lanterns flanking the front door
    if (grid.inBounds(dx - 2, 1, bz2 + 1))
      grid.set(dx - 2, 1, bz2 + 1, style.lanternFloor);
    if (grid.inBounds(dx + 2, 1, bz2 + 1))
      grid.set(dx + 2, 1, bz2 + 1, style.lanternFloor);
  }
  frontDoor(grid, dx, 1, bz2, style, 'north');

  const stairX = xMid + 3;
  const stairX2 = xMid + 4;
  for (let story = 0; story < floors - 1; story++) {
    const by = story * STORY_H;
    const nextY = (story + 1) * STORY_H;
    staircase(grid, stairX, stairX2, bz1 + 2, by, nextY, gh);
  }

  const roomAssignment = resolveRooms(floors, rooms, rng, 'house');
  for (let story = 0; story < floors; story++) {
    const by = story * STORY_H;
    const fy = by + 1;
    const storyRooms = roomAssignment[story];

    const quadrants: RoomBounds[] = [
      { x1: bx1 + 1, y: fy, z1: bz1 + 1, x2: xMid - 1, z2: zMid - 1, height: STORY_H - 1 },
      { x1: bx1 + 1, y: fy, z1: zMid + 1, x2: xMid - 1, z2: bz2 - 1, height: STORY_H - 1 },
      { x1: xMid + 1, y: fy, z1: zMid + 1, x2: bx2 - 1, z2: bz2 - 1, height: STORY_H - 1 },
      { x1: xMid + 1, y: fy, z1: bz1 + 1, x2: bx2 - 1, z2: zMid - 1, height: STORY_H - 1 },
    ];

    for (let q = 0; q < Math.min(storyRooms.length, quadrants.length); q++) {
      const roomType = storyRooms[q];
      const generator = getRoomGenerator(roomType);
      generator(grid, quadrants[q], style);
    }
  }

  // ── Roof ───────────────────────────────────────────────────────────
  const roofBase = floors * STORY_H;
  switch (roofShape) {
    case 'hip':     hipRoof(grid, bx1, bz1, bx2, bz2, roofBase, effectiveRoofH, style); break;
    case 'flat':    flatRoof(grid, bx1, bz1, bx2, bz2, roofBase, effectiveRoofH, style); break;
    case 'gambrel': gambrelRoof(grid, bx1, bz1, bx2, bz2, roofBase, effectiveRoofH, style); break;
    case 'mansard': mansardRoof(grid, bx1, bz1, bx2, bz2, roofBase, effectiveRoofH, style); break;
    case 'gable':
    default:        gabledRoof(grid, bx1, bz1, bx2, bz2, roofBase, effectiveRoofH, style); break;
  }

  // ── L/T/U-shaped wing ──────────────────────────────────────────────
  if (planShape !== 'rect' && wingW > 0 && wingL > 0) {
    // Wing extends off the east side of the main building
    const wx1 = bx2 + 1;
    const wx2 = wx1 + wingW - 1;
    // L-shape: wing on back half; T-shape: wing centered; U-shape: two wings
    const wz1 = planShape === 'T' ? zMid - Math.floor(wingL / 2) : bz1;
    const wz2 = wz1 + wingL - 1;

    // Wing shell (ground floor only for simplicity)
    foundation(grid, wx1, wz1, wx2, wz2, style);
    floor(grid, wx1 + 1, 0, wz1 + 1, wx2 - 1, wz2 - 1, style, true);
    exteriorWalls(grid, wx1, 1, wz1, wx2, STORY_H - 1, wz2, style);
    windows(grid, wx1, wz1, wx2, wz2, 3, 4, style);
    grid.fill(wx1, STORY_H, wz1, wx2, STORY_H, wz2, style.ceiling);
    wallTorches(grid, wx1, wz1, wx2, wz2, 3, style);

    // Roof over wing — uses style's preferred shape
    const wingRoofBase = STORY_H;
    const wingRoofH = effectiveRoofH;
    switch (roofShape) {
      case 'hip':     hipRoof(grid, wx1, wz1, wx2, wz2, wingRoofBase, wingRoofH, style); break;
      case 'flat':    flatRoof(grid, wx1, wz1, wx2, wz2, wingRoofBase, wingRoofH, style); break;
      case 'gambrel': gambrelRoof(grid, wx1, wz1, wx2, wz2, wingRoofBase, wingRoofH, style); break;
      case 'mansard': mansardRoof(grid, wx1, wz1, wx2, wz2, wingRoofBase, wingRoofH, style); break;
      case 'gable':
      default:        gabledRoof(grid, wx1, wz1, wx2, wz2, wingRoofBase, wingRoofH, style); break;
    }

    // Connecting doorway between main body and wing
    const connectZ = Math.max(bz1 + 1, Math.min(wz1 + Math.floor(wingL / 2), bz2 - 1));
    doorway(grid, bx2, 1, connectZ - 1, bx2, 3, connectZ + 1);

    // Wing rooms (use remaining rooms from assignment or defaults)
    const wingBounds: RoomBounds = {
      x1: wx1 + 1, y: 1, z1: wz1 + 1, x2: wx2 - 1, z2: wz2 - 1, height: STORY_H - 1,
    };
    // Pick a sensible room for the wing
    const wingRoom = rooms?.find(r => r === 'garage' || r === 'sunroom' || r === 'study') ?? 'study';
    const wingGen = getRoomGenerator(wingRoom);
    wingGen(grid, wingBounds, style);

    // U-shape: second wing on the west side
    if (planShape === 'U') {
      const wx1b = Math.max(0, bx1 - wingW);
      const wx2b = bx1 - 1;
      if (wx2b > wx1b) {
        foundation(grid, wx1b, wz1, wx2b, wz2, style);
        floor(grid, wx1b + 1, 0, wz1 + 1, wx2b - 1, wz2 - 1, style, true);
        exteriorWalls(grid, wx1b, 1, wz1, wx2b, STORY_H - 1, wz2, style);
        windows(grid, wx1b, wz1, wx2b, wz2, 3, 4, style);
        grid.fill(wx1b, STORY_H, wz1, wx2b, STORY_H, wz2, style.ceiling);
        // U-shape west wing roof — same shape as main
        switch (roofShape) {
          case 'hip':     hipRoof(grid, wx1b, wz1, wx2b, wz2, STORY_H, wingRoofH, style); break;
          case 'flat':    flatRoof(grid, wx1b, wz1, wx2b, wz2, STORY_H, wingRoofH, style); break;
          case 'gambrel': gambrelRoof(grid, wx1b, wz1, wx2b, wz2, STORY_H, wingRoofH, style); break;
          case 'mansard': mansardRoof(grid, wx1b, wz1, wx2b, wz2, STORY_H, wingRoofH, style); break;
          case 'gable':
          default:        gabledRoof(grid, wx1b, wz1, wx2b, wz2, STORY_H, wingRoofH, style); break;
        }
        doorway(grid, bx1, 1, connectZ - 1, bx1, 3, connectZ + 1);
        const wing2Bounds: RoomBounds = {
          x1: wx1b + 1, y: 1, z1: wz1 + 1, x2: wx2b - 1, z2: wz2 - 1, height: STORY_H - 1,
        };
        const wing2Room = rooms?.find(r => r === 'library' || r === 'laundry') ?? 'living';
        getRoomGenerator(wing2Room)(grid, wing2Bounds, style);
      }
    }
  }

  // ── Feature flags (default: all enabled for houses) ───────────────
  // Note: porch is handled earlier (before staircases) for grid layout ordering
  const f = {
    chimney:  features?.chimney  ?? true,
    backyard: features?.backyard ?? true,
    driveway: features?.driveway ?? true,
    fence:    features?.fence    ?? true,
    trees:    features?.trees    ?? true,
    garden:   features?.garden   ?? true,
    pool:     features?.pool     ?? false,
  };

  // Chimney (skip for flat roofs — no peak to rise through)
  if (f.chimney && roofShape !== 'flat') {
    const chimX = Math.floor((bx1 + 1 + xMid - 1) / 2);
    const chimTop = roofBase + effectiveRoofH - 2;
    chimney(grid, chimX, bz1, STORY_H, chimTop);
  }

  // Exterior features, each gated by its flag
  if (f.backyard) addBackyard(grid, bx1, bx2, bz1, style, rng);
  if (f.driveway) addDriveway(grid, xMid, bz2, porchDepth);
  if (f.fence)    addPropertyFence(grid, bx1, bz1, bx2, bz2, xMid, style);

  // Swimming pool in backyard area
  if (f.pool) {
    const poolX = Math.floor((bx1 + bx2) / 2);
    const poolZ = Math.max(3, bz1 - 6);
    if (grid.inBounds(poolX, 0, poolZ))
      placePool(grid, poolX, poolZ);
  }

  // Additional trees in front/side yard
  if (f.trees) {
    const treeX = Math.max(0, bx1 - 1);
    const treeZ = bz2 + porchDepth + 4;
    if (grid.inBounds(treeX, 1, treeZ)) placeTree(grid, treeX, 1, treeZ, 'oak', 5);
    const treeX2 = Math.min(grid.width - 1, bx2 + 1);
    if (grid.inBounds(treeX2, 1, treeZ)) placeTree(grid, treeX2, 1, treeZ, 'birch', 4);
  }

  // Side garden
  if (f.garden) {
    const gardenX1 = Math.max(0, bx1 - 1);
    const gardenZ1 = bz1 + 2;
    const gardenZ2 = Math.min(gardenZ1 + 3, bz2 - 2);
    if (gardenZ2 > gardenZ1 && grid.inBounds(gardenX1, 0, gardenZ2))
      placeGarden(grid, gardenX1 - 1, gardenZ1, gardenX1, gardenZ2, 0, rng);
  }

  // ── Compositional outbuildings — break "single box" silhouette for all house styles ──
  // Fantasy Cottage: garden shed + flower garden with fence + ivy walls
  if (style.wallAccent === 'minecraft:chiseled_stone_bricks') {
    // Garden shed to the west
    const shedX = Math.max(0, bx1 - 8);
    const shedZ = zMid - 2;
    placeOutbuilding(grid, shedX, shedZ, 5, 5, 3, style, 'gable');
    // Gravel path connecting shed to house front
    for (let x = shedX + 5; x <= bx1; x++) {
      if (grid.inBounds(x, 0, shedZ + 2))
        grid.set(x, 0, shedZ + 2, 'minecraft:gravel');
    }
    // Fenced flower garden south of shed
    const fgX1 = shedX;
    const fgZ1 = bz2 + 2;
    const fgX2 = fgX1 + 6;
    if (grid.inBounds(fgX2 + 1, 1, fgZ1 + 5)) {
      for (let x = fgX1; x <= fgX2; x++) {
        for (let z = fgZ1; z <= fgZ1 + 4; z++) {
          if (grid.inBounds(x, 0, z)) grid.set(x, 0, z, 'minecraft:grass_block');
        }
      }
      const fFlowers = ['minecraft:rose_bush', 'minecraft:lilac', 'minecraft:peony', 'minecraft:sunflower'];
      for (let i = 0; i < 8; i++) {
        const fx = fgX1 + Math.floor(rng() * 7);
        const fz = fgZ1 + Math.floor(rng() * 5);
        if (grid.inBounds(fx, 1, fz))
          grid.set(fx, 1, fz, pick(fFlowers, rng));
      }
      for (let x = fgX1 - 1; x <= fgX2 + 1; x++) {
        if (grid.inBounds(x, 1, fgZ1 - 1)) grid.set(x, 1, fgZ1 - 1, style.fence);
        if (grid.inBounds(x, 1, fgZ1 + 5)) grid.set(x, 1, fgZ1 + 5, style.fence);
      }
      for (let z = fgZ1 - 1; z <= fgZ1 + 5; z++) {
        if (grid.inBounds(fgX1 - 1, 1, z)) grid.set(fgX1 - 1, 1, z, style.fence);
        if (grid.inBounds(fgX2 + 1, 1, z)) grid.set(fgX2 + 1, 1, z, style.fence);
      }
    }
    // Ivy/azalea climbing west wall
    for (let y = 1; y <= Math.min(floors * STORY_H - 1, 6); y++) {
      for (let z = bz1 + 2; z <= bz2 - 2; z += 2) {
        if (grid.inBounds(bx1 - 1, y, z) && rng() < 0.5)
          grid.set(bx1 - 1, y, z, 'minecraft:azalea_leaves[persistent=true]');
      }
    }
  }

  // Modern House: detached carport + landscaped yard
  if (style.wallAccent === 'minecraft:light_gray_concrete') {
    // Minimalist carport to the west
    const cpX = Math.max(0, bx1 - 9);
    const cpZ = bz1;
    if (grid.inBounds(cpX, 0, cpZ)) {
      // Flat roof carport (open sides)
      grid.fill(cpX, 0, cpZ, cpX + 6, 0, cpZ + 5, 'minecraft:polished_andesite');
      // Corner pillars only
      for (const [px, pz] of [[cpX, cpZ], [cpX + 6, cpZ], [cpX, cpZ + 5], [cpX + 6, cpZ + 5]] as [number, number][]) {
        for (let y = 1; y <= 3; y++) {
          if (grid.inBounds(px, y, pz)) grid.set(px, y, pz, 'minecraft:quartz_pillar');
        }
      }
      // Flat slab roof
      grid.fill(cpX, 4, cpZ, cpX + 6, 4, cpZ + 5, 'minecraft:smooth_quartz_slab[type=bottom]');
    }
    // Stepping stone path from carport to house
    for (let x = cpX + 7; x <= bx1; x += 2) {
      if (grid.inBounds(x, 0, cpZ + 2))
        grid.set(x, 0, cpZ + 2, 'minecraft:smooth_stone_slab[type=bottom]');
    }
    // Decorative ground cover (different materials for modern landscape)
    for (let x = Math.max(0, bx1 - 2); x <= bx2 + 2; x++) {
      for (let z = bz2 + porchDepth + 1; z <= bz2 + porchDepth + 3; z++) {
        if (grid.inBounds(x, 0, z) && grid.get(x, 0, z) === 'minecraft:air')
          grid.set(x, 0, z, x % 3 === 0 ? 'minecraft:smooth_stone' : 'minecraft:light_gray_concrete');
      }
    }
  }

  // ── Modern facade enhancements: cantilever + glass curtain wall + rooftop ──
  if (style.wall === 'minecraft:white_concrete') {
    // Horizontal accent bands between floors for visual depth
    for (let story = 1; story < floors; story++) {
      accentBand(grid, bx1, story * STORY_H, bz1, bx2, bz2, style.wallAccent);
    }
    // Ground floor: full glass curtain wall on front AND east side
    glassCurtainWall(grid, bx1 + 2, 2, STORY_H - 2, bz2, bx2 - 2, style.window);
    // East side glass wall (ground floor)
    for (let z = bz1 + 2; z <= bz2 - 2; z++) {
      for (let y = 2; y <= STORY_H - 2; y++) {
        if (grid.inBounds(bx2, y, z))
          grid.set(bx2, y, z, style.window);
      }
    }
    // Upper floor cantilever — extends 2 blocks beyond ground floor on south + east
    if (floors >= 2) {
      // South cantilever overhang (3 blocks deep)
      for (let x = bx1; x <= bx2 + 2; x++) {
        for (let dz = 1; dz <= 3; dz++) {
          if (grid.inBounds(x, STORY_H, bz2 + dz))
            grid.set(x, STORY_H, bz2 + dz, 'minecraft:white_concrete');
        }
      }
      // East cantilever overhang (2 blocks deep)
      for (let z = bz1; z <= bz2; z++) {
        for (let dx = 1; dx <= 2; dx++) {
          if (grid.inBounds(bx2 + dx, STORY_H, z))
            grid.set(bx2 + dx, STORY_H, z, 'minecraft:white_concrete');
        }
      }
      // Cantilever underside — dark accent slab to emphasize shadow
      for (let x = bx1; x <= bx2 + 2; x++) {
        if (grid.inBounds(x, STORY_H - 1, bz2 + 2))
          grid.set(x, STORY_H - 1, bz2 + 2, 'minecraft:gray_concrete');
      }
      // Upper floor walls on cantilever extension
      for (let y = STORY_H + 1; y <= 2 * STORY_H - 1; y++) {
        for (let x = bx1; x <= bx2 + 2; x++) {
          if (grid.inBounds(x, y, bz2 + 3))
            grid.set(x, y, bz2 + 3, style.wall);
        }
        // East extended wall
        if (grid.inBounds(bx2 + 2, y, bz2 + 2))
          grid.set(bx2 + 2, y, bz2 + 2, style.wall);
      }
      // Upper floor glass on cantilever front
      for (let x = bx1 + 2; x <= bx2; x++) {
        for (let y = STORY_H + 2; y <= 2 * STORY_H - 2; y++) {
          if (grid.inBounds(x, y, bz2 + 3))
            grid.set(x, y, bz2 + 3, style.window);
        }
      }
    }
    // Rooftop terrace — flat roof with glass railing and planter boxes
    const roofTop = floors * STORY_H;
    // Glass railing around rooftop
    for (let x = bx1; x <= bx2; x++) {
      if (grid.inBounds(x, roofTop + 1, bz1))
        grid.set(x, roofTop + 1, bz1, 'minecraft:glass_pane');
      if (grid.inBounds(x, roofTop + 1, bz2))
        grid.set(x, roofTop + 1, bz2, 'minecraft:glass_pane');
    }
    for (let z = bz1; z <= bz2; z++) {
      if (grid.inBounds(bx1, roofTop + 1, z))
        grid.set(bx1, roofTop + 1, z, 'minecraft:glass_pane');
      if (grid.inBounds(bx2, roofTop + 1, z))
        grid.set(bx2, roofTop + 1, z, 'minecraft:glass_pane');
    }
    // Planter boxes on rooftop corners
    for (const [px, pz] of [[bx1 + 1, bz1 + 1], [bx2 - 1, bz1 + 1],
                              [bx1 + 1, bz2 - 1], [bx2 - 1, bz2 - 1]] as [number, number][]) {
      if (grid.inBounds(px, roofTop + 1, pz))
        grid.set(px, roofTop + 1, pz, 'minecraft:potted_fern');
    }
    // Exterior accent: dark concrete base trim
    for (let x = bx1; x <= bx2; x++) {
      for (const z of [bz1, bz2]) {
        if (grid.inBounds(x, 0, z)) grid.set(x, 0, z, 'minecraft:gray_concrete');
      }
    }
  }

  // ── Medieval manor enhancements: dormers + weathering + heraldic detail ──
  if (style.wall === 'minecraft:stone_bricks') {
    // Weathered exterior walls
    const medievalVariants = [
      'minecraft:mossy_stone_bricks', 'minecraft:cracked_stone_bricks',
    ];
    weatherWalls(grid, bx1, 0, bz1, bx2, floors * STORY_H, bz2, style.wall, medievalVariants, rng, 0.15);
    // ── Dormer windows — break up heavy roofline (south-facing) ──
    const dormerSpacing = Math.max(6, Math.floor(bw / 3));
    for (let dx = bx1 + dormerSpacing; dx <= bx2 - dormerSpacing; dx += dormerSpacing) {
      const dormerBase = roofBase + 2;
      // Dormer walls (3 wide, 3 tall box projecting from roof)
      for (let y = dormerBase; y <= dormerBase + 2; y++) {
        for (let ddx = -1; ddx <= 1; ddx++) {
          if (grid.inBounds(dx + ddx, y, bz2 + 1))
            grid.set(dx + ddx, y, bz2 + 1, style.wall);
        }
      }
      // Dormer window
      if (grid.inBounds(dx, dormerBase + 1, bz2 + 1))
        grid.set(dx, dormerBase + 1, bz2 + 1, style.window);
      // Dormer roof (mini gable — 3 blocks)
      if (grid.inBounds(dx - 1, dormerBase + 3, bz2 + 1))
        grid.set(dx - 1, dormerBase + 3, bz2 + 1, style.roofS);
      if (grid.inBounds(dx, dormerBase + 3, bz2 + 1))
        grid.set(dx, dormerBase + 3, bz2 + 1, style.roofS);
      if (grid.inBounds(dx + 1, dormerBase + 3, bz2 + 1))
        grid.set(dx + 1, dormerBase + 3, bz2 + 1, style.roofS);
      if (grid.inBounds(dx, dormerBase + 4, bz2 + 1))
        grid.set(dx, dormerBase + 4, bz2 + 1, style.roofCap);
    }
    // Flower boxes under front-facing windows
    for (let x = bx1 + 4; x <= bx2 - 4; x += 4) {
      if (grid.inBounds(x, 1, bz2 + 1))
        grid.set(x, 1, bz2 + 1, 'minecraft:potted_red_tulip');
    }
    // Banners on side walls — heraldic identity
    for (let story = 0; story < floors; story++) {
      const banY = story * STORY_H + 3;
      if (grid.inBounds(bx1 - 1, banY, zMid))
        grid.set(bx1 - 1, banY, zMid, 'minecraft:red_wall_banner[facing=west]');
      if (grid.inBounds(bx2 + 1, banY, zMid))
        grid.set(bx2 + 1, banY, zMid, 'minecraft:red_wall_banner[facing=east]');
    }
    // Prominent chimney — taller, with stone brick cap
    const chimBaseY = roofBase + effectiveRoofH - 3;
    const chimX2 = bx1 + 3;
    for (let y = chimBaseY; y <= chimBaseY + 4; y++) {
      if (grid.inBounds(chimX2, y, bz1 + 2))
        grid.set(chimX2, y, bz1 + 2, 'minecraft:stone_bricks');
      if (grid.inBounds(chimX2 + 1, y, bz1 + 2))
        grid.set(chimX2 + 1, y, bz1 + 2, 'minecraft:stone_bricks');
    }
    // Chimney cap
    if (grid.inBounds(chimX2, chimBaseY + 5, bz1 + 2))
      grid.set(chimX2, chimBaseY + 5, bz1 + 2, style.slabBottom);
    if (grid.inBounds(chimX2 + 1, chimBaseY + 5, bz1 + 2))
      grid.set(chimX2 + 1, chimBaseY + 5, bz1 + 2, style.slabBottom);
    // Courtyard well for manor estate feel
    const wellMX = bx1 - 3;
    const wellMZ = zMid;
    if (grid.inBounds(wellMX, 0, wellMZ)) {
      grid.set(wellMX, 0, wellMZ, 'minecraft:cobblestone');
      grid.set(wellMX, 1, wellMZ, 'minecraft:water_cauldron[level=3]');
      for (const [fx, fz] of [[wellMX - 1, wellMZ - 1], [wellMX + 1, wellMZ - 1],
                                [wellMX - 1, wellMZ + 1], [wellMX + 1, wellMZ + 1]] as [number, number][]) {
        if (grid.inBounds(fx, 1, fz)) grid.set(fx, 1, fz, style.fence);
      }
    }
    // Detached stable building — adds compositional complexity
    const stbX = Math.max(0, bx1 - 10);
    const stbZ = bz1 + 2;
    placeOutbuilding(grid, stbX, stbZ, 7, 6, 3, style, 'lean-to');
    // Hay bales inside stable
    if (grid.inBounds(stbX + 1, 1, stbZ + 1))
      grid.set(stbX + 1, 1, stbZ + 1, 'minecraft:hay_block');
    if (grid.inBounds(stbX + 1, 2, stbZ + 1))
      grid.set(stbX + 1, 2, stbZ + 1, 'minecraft:hay_block');
    // Cobblestone courtyard path from stable to manor
    for (let x = stbX + 7; x <= bx1; x++) {
      if (grid.inBounds(x, 0, stbZ + 3))
        grid.set(x, 0, stbZ + 3, 'minecraft:cobblestone');
    }
    // Estate perimeter stone wall (partial — north and west sides)
    const wallXStart = Math.max(0, stbX - 2);
    for (let x = wallXStart; x <= bx2 + 2; x++) {
      if (grid.inBounds(x, 1, Math.max(0, bz1 - 2)))
        grid.set(x, 1, Math.max(0, bz1 - 2), 'minecraft:cobblestone_wall');
    }
    for (let z = Math.max(0, bz1 - 2); z <= bz2 + 2; z++) {
      if (grid.inBounds(wallXStart, 1, z))
        grid.set(wallXStart, 1, z, 'minecraft:cobblestone_wall');
    }
  }

  // ── Rustic cabin enhancements: log construction + wrap-around porch + woodsman vibe ──
  if (style.wall === 'minecraft:spruce_planks') {
    // Full log corner construction — EVERY corner column is stripped log
    for (let y = 1; y <= floors * STORY_H; y++) {
      for (const [lx, lz] of [[bx1, bz1], [bx2, bz1], [bx1, bz2], [bx2, bz2]] as [number, number][]) {
        if (grid.inBounds(lx, y, lz))
          grid.set(lx, y, lz, 'minecraft:stripped_spruce_log');
      }
    }
    // Alternating log layer accents on walls — cabin log construction look
    for (let y = 1; y <= floors * STORY_H; y += 2) {
      for (let x = bx1; x <= bx2; x++) {
        if (grid.inBounds(x, y, bz1) && grid.get(x, y, bz1) === style.wall)
          grid.set(x, y, bz1, 'minecraft:spruce_log[axis=x]');
        if (grid.inBounds(x, y, bz2) && grid.get(x, y, bz2) === style.wall)
          grid.set(x, y, bz2, 'minecraft:spruce_log[axis=x]');
      }
      for (let z = bz1; z <= bz2; z++) {
        if (grid.inBounds(bx1, y, z) && grid.get(bx1, y, z) === style.wall)
          grid.set(bx1, y, z, 'minecraft:spruce_log[axis=z]');
        if (grid.inBounds(bx2, y, z) && grid.get(bx2, y, z) === style.wall)
          grid.set(bx2, y, z, 'minecraft:spruce_log[axis=z]');
      }
    }
    // Wrap-around covered porch on south + east sides
    const porchW = 2;
    // South porch extension
    for (let x = bx1 - 1; x <= bx2 + porchW + 1; x++) {
      if (grid.inBounds(x, 0, bz2 + porchW + 1))
        grid.set(x, 0, bz2 + porchW + 1, style.floorGround);
    }
    // East porch extension
    for (let z = bz1; z <= bz2 + porchW + 1; z++) {
      for (let dx = 1; dx <= porchW + 1; dx++) {
        if (grid.inBounds(bx2 + dx, 0, z))
          grid.set(bx2 + dx, 0, z, style.floorGround);
      }
    }
    // Porch support posts (fence + log columns)
    const porchPosts: [number, number][] = [
      [bx1 - 1, bz2 + porchW + 1], [bx2 + porchW + 1, bz2 + porchW + 1],
      [bx2 + porchW + 1, bz1], [bx2 + porchW + 1, zMid],
    ];
    for (const [px, pz] of porchPosts) {
      for (let y = 1; y <= STORY_H - 1; y++) {
        if (grid.inBounds(px, y, pz))
          grid.set(px, y, pz, 'minecraft:stripped_spruce_log');
      }
    }
    // Porch railing (fence between posts)
    for (let x = bx1; x <= bx2 + porchW; x++) {
      if (grid.inBounds(x, 1, bz2 + porchW + 1))
        grid.set(x, 1, bz2 + porchW + 1, style.fence);
    }
    for (let z = bz1 + 1; z <= bz2 + porchW; z++) {
      if (grid.inBounds(bx2 + porchW + 1, 1, z))
        grid.set(bx2 + porchW + 1, 1, z, style.fence);
    }
    // Large woodpile against north wall (2 wide, 3 tall)
    for (let y = 1; y <= 3; y++) {
      for (let dz = 0; dz < 3; dz++) {
        if (grid.inBounds(bx2 + 1, y, bz1 + dz))
          grid.set(bx2 + 1, y, bz1 + dz, 'minecraft:spruce_log[axis=x]');
      }
    }
    // Campfire with seating
    if (grid.inBounds(xMid - 4, 0, bz2 + 4))
      grid.set(xMid - 4, 0, bz2 + 4, 'minecraft:cobblestone');
    if (grid.inBounds(xMid - 4, 1, bz2 + 4))
      grid.set(xMid - 4, 1, bz2 + 4, 'minecraft:campfire[lit=true]');
    // Log benches around campfire
    for (const [sx, sz] of [[xMid - 6, bz2 + 4], [xMid - 4, bz2 + 6]] as [number, number][]) {
      if (grid.inBounds(sx, 1, sz))
        grid.set(sx, 1, sz, 'minecraft:spruce_log[axis=x]');
    }
    // Stone cobble path from porch to campfire
    for (let dz = 1; dz <= 3; dz++) {
      if (grid.inBounds(xMid - 2, 0, bz2 + dz))
        grid.set(xMid - 2, 0, bz2 + dz, 'minecraft:cobblestone');
    }
    // Woodshed / outhouse — separate small structure for compositional variety
    const outX = Math.max(0, bx1 - 7);
    const outZ = bz1;
    placeOutbuilding(grid, outX, outZ, 4, 4, 3, style, 'lean-to');
    // Logs stacked outside woodshed
    for (let y = 1; y <= 2; y++) {
      if (grid.inBounds(outX + 4, y, outZ + 1))
        grid.set(outX + 4, y, outZ + 1, 'minecraft:spruce_log[axis=z]');
      if (grid.inBounds(outX + 4, y, outZ + 2))
        grid.set(outX + 4, y, outZ + 2, 'minecraft:spruce_log[axis=z]');
    }
    // Dirt path from woodshed to cabin
    for (let x = outX + 4; x <= bx1; x++) {
      if (grid.inBounds(x, 0, outZ + 2))
        grid.set(x, 0, outZ + 2, 'minecraft:dirt_path');
    }
    // Fishing dock extending south (waterfront cabin feel)
    const dockZ = bz2 + porchW + 3;
    const dockX = bx2 + 3;
    for (let z = dockZ; z <= dockZ + 6; z++) {
      if (grid.inBounds(dockX, 0, z))
        grid.set(dockX, 0, z, style.floorGround);
      if (grid.inBounds(dockX + 1, 0, z))
        grid.set(dockX + 1, 0, z, style.floorGround);
    }
    // Dock posts
    for (const dz of [dockZ, dockZ + 6]) {
      if (grid.inBounds(dockX, 1, dz))
        grid.set(dockX, 1, dz, style.fence);
      if (grid.inBounds(dockX + 1, 1, dz))
        grid.set(dockX + 1, 1, dz, style.fence);
    }
  }

  // ── Steampunk workshop enhancements: heavy industrial aesthetic ──
  if (style.wall === 'minecraft:iron_block') {
    // Vertical pipe runs on ALL exterior walls — copper + lightning rod stacks
    for (let z = bz1 + 2; z <= bz2 - 2; z += 3) {
      for (let y = 1; y <= floors * STORY_H; y++) {
        if (grid.inBounds(bx1 - 1, y, z))
          grid.set(bx1 - 1, y, z, y % 2 === 0 ? 'minecraft:lightning_rod' : 'minecraft:chain');
        if (grid.inBounds(bx2 + 1, y, z))
          grid.set(bx2 + 1, y, z, y % 2 === 0 ? 'minecraft:lightning_rod' : 'minecraft:chain');
      }
    }
    // Horizontal pipe runs connecting verticals (cross bracing)
    for (let y = 2; y <= floors * STORY_H; y += STORY_H) {
      for (let x = bx1; x <= bx2; x += 2) {
        if (grid.inBounds(x, y, bz1 - 1))
          grid.set(x, y, bz1 - 1, 'minecraft:exposed_copper');
        if (grid.inBounds(x, y, bz2 + 1))
          grid.set(x, y, bz2 + 1, 'minecraft:exposed_copper');
      }
    }
    // Copper accent base band — oxidized copper for aged industrial look
    for (let x = bx1; x <= bx2; x++) {
      if (grid.inBounds(x, 1, bz1)) grid.set(x, 1, bz1, 'minecraft:exposed_copper');
      if (grid.inBounds(x, 1, bz2)) grid.set(x, 1, bz2, 'minecraft:exposed_copper');
    }
    for (let z = bz1; z <= bz2; z++) {
      if (grid.inBounds(bx1, 1, z)) grid.set(bx1, 1, z, 'minecraft:exposed_copper');
      if (grid.inBounds(bx2, 1, z)) grid.set(bx2, 1, z, 'minecraft:exposed_copper');
    }
    // Piston "gear" array on front facade — 3-wide mechanical feature
    for (let dx = -1; dx <= 1; dx++) {
      if (grid.inBounds(bx1 + 3 + dx, 3, bz2))
        grid.set(bx1 + 3 + dx, 3, bz2, 'minecraft:piston[facing=south]');
      if (grid.inBounds(bx2 - 3 + dx, 3, bz2))
        grid.set(bx2 - 3 + dx, 3, bz2, 'minecraft:sticky_piston[facing=south]');
    }
    // Observer blocks as "gauges" on north wall
    for (let x = bx1 + 3; x <= bx2 - 3; x += 5) {
      if (grid.inBounds(x, 3, bz1))
        grid.set(x, 3, bz1, 'minecraft:observer[facing=north]');
    }
    // Redstone lamps flanking door + above
    if (grid.inBounds(xMid - 2, STORY_H - 1, bz2 + 1))
      grid.set(xMid - 2, STORY_H - 1, bz2 + 1, 'minecraft:redstone_lamp');
    if (grid.inBounds(xMid + 2, STORY_H - 1, bz2 + 1))
      grid.set(xMid + 2, STORY_H - 1, bz2 + 1, 'minecraft:redstone_lamp');
    // DUAL smokestacks — taller, with copper banding
    for (const stackX of [bx1 + 2, bx2 - 2]) {
      const stackBase = floors * STORY_H + 1;
      for (let y = stackBase; y <= stackBase + 5; y++) {
        if (grid.inBounds(stackX, y, bz1 + 2)) {
          const block = y % 3 === 0 ? 'minecraft:exposed_copper' : 'minecraft:iron_block';
          grid.set(stackX, y, bz1 + 2, block);
        }
      }
      if (grid.inBounds(stackX, stackBase + 6, bz1 + 2))
        grid.set(stackX, stackBase + 6, bz1 + 2, 'minecraft:campfire[lit=true]');
    }
    // Copper roof trim — replace roof edge blocks with oxidized copper
    const roofY = floors * STORY_H;
    for (let x = bx1; x <= bx2; x++) {
      if (grid.inBounds(x, roofY + 1, bz1)) grid.set(x, roofY + 1, bz1, 'minecraft:oxidized_copper');
      if (grid.inBounds(x, roofY + 1, bz2)) grid.set(x, roofY + 1, bz2, 'minecraft:oxidized_copper');
    }
    // Exterior workbench + anvil — workshop identity
    if (grid.inBounds(bx2 + 2, 1, zMid))
      grid.set(bx2 + 2, 1, zMid, 'minecraft:smithing_table');
    if (grid.inBounds(bx2 + 2, 1, zMid + 1))
      grid.set(bx2 + 2, 1, zMid + 1, 'minecraft:anvil[facing=north]');
    if (grid.inBounds(bx2 + 2, 1, zMid - 1))
      grid.set(bx2 + 2, 1, zMid - 1, 'minecraft:blast_furnace[facing=west]');
    // ── LARGE external boiler tower — the dominant visual element for steampunk ──
    // Separate cylindrical structure west of workshop, connected by pipe bridge
    const btX = Math.max(2, bx1 - 9);
    const btZ = zMid;
    const btR = 3;
    const btH = floors * STORY_H + 8; // Taller than main workshop
    // Cylindrical tower
    for (let y = 0; y <= btH; y++) {
      for (let dx = -btR; dx <= btR; dx++) {
        for (let dz = -btR; dz <= btR; dz++) {
          if (Math.sqrt(dx * dx + dz * dz) <= btR + 0.5) {
            const tx = btX + dx;
            const tz = btZ + dz;
            if (!grid.inBounds(tx, y, tz)) continue;
            if (y === 0) {
              grid.set(tx, y, tz, 'minecraft:iron_block');
            } else if (Math.sqrt(dx * dx + dz * dz) >= btR - 0.5) {
              // Alternating copper + iron bands
              grid.set(tx, y, tz, y % 4 === 0 ? 'minecraft:exposed_copper' : 'minecraft:iron_block');
            }
          }
        }
      }
    }
    // Massive smokestack on top of boiler tower
    for (let y = btH + 1; y <= btH + 5; y++) {
      if (grid.inBounds(btX, y, btZ))
        grid.set(btX, y, btZ, 'minecraft:iron_block');
      if (grid.inBounds(btX + 1, y, btZ))
        grid.set(btX + 1, y, btZ, 'minecraft:iron_block');
    }
    if (grid.inBounds(btX, btH + 6, btZ))
      grid.set(btX, btH + 6, btZ, 'minecraft:campfire[lit=true]');
    // Pipe bridge connecting boiler tower to workshop
    const bridgeY = Math.floor(floors * STORY_H * 0.6);
    for (let x = btX + btR + 1; x <= bx1; x++) {
      if (grid.inBounds(x, bridgeY, btZ))
        grid.set(x, bridgeY, btZ, 'minecraft:exposed_copper');
      if (grid.inBounds(x, bridgeY + 1, btZ))
        grid.set(x, bridgeY + 1, btZ, 'minecraft:chain');
    }
    // Crane arm extending from workshop roof
    const craneBase = floors * STORY_H + 2;
    const craneX = bx2;
    for (let y = craneBase; y <= craneBase + 4; y++) {
      if (grid.inBounds(craneX, y, bz2))
        grid.set(craneX, y, bz2, 'minecraft:iron_block');
    }
    // Horizontal crane arm
    for (let z = bz2; z <= bz2 + 5; z++) {
      if (grid.inBounds(craneX, craneBase + 4, z))
        grid.set(craneX, craneBase + 4, z, 'minecraft:iron_block');
    }
    // Crane cable + hook
    for (let y = craneBase; y <= craneBase + 3; y++) {
      if (grid.inBounds(craneX, y, bz2 + 5))
        grid.set(craneX, y, bz2 + 5, 'minecraft:chain');
    }
    // Rail track/conveyor alongside workshop (east side)
    for (let z = bz1; z <= bz2 + 3; z++) {
      if (grid.inBounds(bx2 + 3, 0, z))
        grid.set(bx2 + 3, 0, z, 'minecraft:rail');
    }
  }

  return grid;
}

// ─── Tower ──────────────────────────────────────────────────────────────────

function generateTower(
  floors: number, style: StylePalette, rooms: RoomType[] | undefined,
  bwOpt: number | undefined, _blOpt: number | undefined, rng: () => number
): BlockGrid {
  const radius = bwOpt ? Math.floor(bwOpt / 2) : 8;
  const diam = radius * 2 + 1;
  const margin = 3;
  const gw = diam + margin * 2;
  const gl = diam + margin * 2;
  const gh = floors * STORY_H + ROOF_H + 5;

  const cx = margin + radius;
  const cz = margin + radius;
  const grid = new BlockGrid(gw, gh, gl);

  // Circular foundation
  fillCircle(grid, cx, 0, cz, radius, style.foundation);

  for (let story = 0; story < floors; story++) {
    const by = story * STORY_H;
    const cy = by + STORY_H;

    // Circular floor
    fillCircle(grid, cx, by, cz, radius - 1, story === 0 ? style.floorGround : style.floorUpper);

    // Circular walls — fill circle then hollow interior for gap-free 2-thick wall
    for (let y = by + 1; y < cy; y++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist <= radius + 0.5) {
            grid.set(cx + dx, y, cz + dz, style.wall);
          }
        }
      }
      // Hollow out interior
      for (let dx = -(radius - 2); dx <= radius - 2; dx++) {
        for (let dz = -(radius - 2); dz <= radius - 2; dz++) {
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist <= radius - 2 + 0.5) {
            grid.set(cx + dx, y, cz + dz, 'minecraft:air');
          }
        }
      }
    }

    // Corner pillars at cardinal directions
    const pillarPositions: [number, number][] = [
      [cx + radius, cz], [cx - radius, cz],
      [cx, cz + radius], [cx, cz - radius],
    ];
    for (let y = by; y <= cy; y++) {
      for (const [px, pz] of pillarPositions) {
        if (grid.inBounds(px, y, pz)) grid.set(px, y, pz, style.timber);
      }
    }

    // Windows at cardinal directions
    for (const [wx, wz] of pillarPositions) {
      const dirX = wx - cx;
      const dirZ = wz - cz;
      // Window to the left of each pillar
      const winX = cx + dirX + (dirZ === 0 ? 0 : (dirZ > 0 ? -2 : 2));
      const winZ = cz + dirZ + (dirX === 0 ? 0 : (dirX > 0 ? -2 : 2));
      if (grid.inBounds(winX, by + 2, winZ)) {
        grid.set(winX, by + 2, winZ, style.window);
        grid.set(winX, by + 3, winZ, style.window);
      }
    }

    // Ceiling on top floor
    if (story === floors - 1) {
      fillCircle(grid, cx, cy, cz, radius, style.ceiling);
    }

    // Spiral staircase
    if (story < floors - 1) {
      const stairAngleStart = story * Math.PI * 0.5;
      for (let step = 0; step < 5; step++) {
        const angle = stairAngleStart + (step / 5) * Math.PI * 0.5;
        const sx = cx + Math.round(Math.cos(angle) * (radius - 3));
        const sz = cz + Math.round(Math.sin(angle) * (radius - 3));
        const sy = by + 1 + step;
        if (grid.inBounds(sx, sy, sz)) {
          grid.set(sx, sy, sz, 'minecraft:oak_stairs[facing=south]');
          // Clear above
          for (let cly = sy + 1; cly < sy + 4; cly++) {
            if (grid.inBounds(sx, cly, sz)) grid.set(sx, cly, sz, 'minecraft:air');
          }
        }
      }
      // Open the floor above
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist <= 2.5) {
            const sx = cx + dx + Math.round(Math.cos(stairAngleStart + Math.PI * 0.25) * (radius - 4));
            const sz = cz + dz + Math.round(Math.sin(stairAngleStart + Math.PI * 0.25) * (radius - 4));
            if (grid.inBounds(sx, cy, sz)) grid.set(sx, cy, sz, 'minecraft:air');
          }
        }
      }
    }

    // Torches
    for (const [tx, tz] of pillarPositions) {
      const inX = tx + (tx > cx ? -1 : tx < cx ? 1 : 0);
      const inZ = tz + (tz > cz ? -1 : tz < cz ? 1 : 0);
      if (grid.inBounds(inX, by + 3, inZ)) {
        grid.set(inX, by + 3, inZ, style.lantern);
      }
    }

    // Room furnishing (1 room per floor in tower)
    const allRoomTypes = getRoomTypes();
    const roomType = rooms?.[story] ?? pick(allRoomTypes, rng);
    const gen = getRoomGenerator(roomType);
    const bounds: RoomBounds = {
      x1: cx - radius + 2, y: by + 1,
      z1: cz - radius + 2, x2: cx + radius - 2,
      z2: cz + radius - 2, height: STORY_H - 1,
    };
    gen(grid, bounds, style);
  }

  // Conical roof
  const roofBase = floors * STORY_H;
  for (let layer = 0; layer <= radius + 2; layer++) {
    const ry = roofBase + 1 + layer;
    const rr = radius + 1 - layer;
    if (rr <= 0 || !grid.inBounds(0, ry, 0)) break;
    for (let dx = -rr; dx <= rr; dx++) {
      for (let dz = -rr; dz <= rr; dz++) {
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist <= rr + 0.5 && dist >= rr - 0.5) {
          if (grid.inBounds(cx + dx, ry, cz + dz)) {
            grid.set(cx + dx, ry, cz + dz, layer % 2 === 0 ? style.roofS : style.roofN);
          }
        }
      }
    }
  }

  // Battlement ring on top of roof
  for (let dx = -radius - 1; dx <= radius + 1; dx++) {
    for (let dz = -radius - 1; dz <= radius + 1; dz++) {
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= radius - 0.5 && dist <= radius + 1.5) {
        const bx = cx + dx;
        const bz = cz + dz;
        if (grid.inBounds(bx, roofBase + 1, bz)) {
          grid.set(bx, roofBase + 1, bz, style.wall);
          // Crenellations
          if ((dx + dz) % 3 === 0 && grid.inBounds(bx, roofBase + 2, bz)) {
            grid.set(bx, roofBase + 2, bz, style.wall);
          }
        }
      }
    }
  }

  // Front entrance
  const doorZ = cz - radius;
  if (grid.inBounds(cx, 1, doorZ)) {
    grid.set(cx, 1, doorZ, style.doorLowerS);
    grid.set(cx, 2, doorZ, style.doorUpperS);
    grid.set(cx, 3, doorZ, 'minecraft:air');
  }

  // ── Observation balcony on top floor ──
  const balconyY = (floors - 1) * STORY_H + 2;
  const balcR = radius + 2;
  // Balcony floor ring (extends 2 blocks beyond wall)
  for (let dx = -balcR; dx <= balcR; dx++) {
    for (let dz = -balcR; dz <= balcR; dz++) {
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= radius + 0.5 && dist <= balcR + 0.5) {
        if (grid.inBounds(cx + dx, balconyY, cz + dz))
          grid.set(cx + dx, balconyY, cz + dz, style.slabBottom);
      }
    }
  }
  // Balcony fence railing
  for (let dx = -balcR; dx <= balcR; dx++) {
    for (let dz = -balcR; dz <= balcR; dz++) {
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= balcR - 0.5 && dist <= balcR + 0.5) {
        if (grid.inBounds(cx + dx, balconyY + 1, cz + dz))
          grid.set(cx + dx, balconyY + 1, cz + dz, style.fence);
      }
    }
  }
  // Clear wall openings for balcony access (at cardinal directions)
  for (const [px, pz] of [[cx + radius, cz], [cx - radius, cz], [cx, cz + radius]] as [number, number][]) {
    for (let y = balconyY + 1; y <= balconyY + 2; y++) {
      if (grid.inBounds(px, y, pz)) grid.set(px, y, pz, 'minecraft:air');
    }
  }

  // ── Exterior banners on every floor ──
  for (let story = 0; story < floors; story++) {
    const bannerY = story * STORY_H + 3;
    // Banners at cardinal positions on exterior wall
    if (grid.inBounds(cx, bannerY, cz - radius - 1))
      grid.set(cx, bannerY, cz - radius - 1, style.bannerS);
    if (grid.inBounds(cx, bannerY, cz + radius + 1))
      grid.set(cx, bannerY, cz + radius + 1, style.bannerN);
  }

  // ── Elven Spire enhancements: leaf crown + vine accents + glowing elements ──
  if (style.wall === 'minecraft:moss_block') {
    // Leaf ring at base — overgrown nature vibe
    for (let dx = -radius - 1; dx <= radius + 1; dx++) {
      for (let dz = -radius - 1; dz <= radius + 1; dz++) {
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist >= radius + 0.5 && dist <= radius + 1.5) {
          if (grid.inBounds(cx + dx, 1, cz + dz) && rng() < 0.5)
            grid.set(cx + dx, 1, cz + dz, 'minecraft:azalea_leaves[persistent=true]');
        }
      }
    }
    // Vine accents trailing down exterior walls
    for (let story = 1; story < floors; story++) {
      const vineY = story * STORY_H;
      for (const [vdx, vdz] of [[radius, -1], [-radius, 1], [1, radius], [-1, -radius]]) {
        const vx = cx + vdx;
        const vz = cz + vdz;
        for (let vy = vineY; vy > vineY - 3 && vy > 1; vy--) {
          if (grid.inBounds(vx, vy, vz) && grid.get(vx, vy, vz) === 'minecraft:air')
            grid.set(vx, vy, vz, 'minecraft:vine');
        }
      }
    }
    // Glowstone ring embedded in top floor walls — ethereal glow
    const topR = Math.max(3, radius - (floors - 1));
    const glowY = (floors - 1) * STORY_H + 2;
    for (const [gdx, gdz] of [[topR, 0], [-topR, 0], [0, topR], [0, -topR]]) {
      if (grid.inBounds(cx + gdx, glowY, cz + gdz))
        grid.set(cx + gdx, glowY, cz + gdz, 'minecraft:sea_lantern');
    }
  }

  // ── Wizard Tower enhancements (fantasy style): enchanting aura + crystal top ──
  if (style.wall === 'minecraft:white_concrete' && style.wallAccent === 'minecraft:chiseled_stone_bricks') {
    // Enchanting table at ground floor center
    if (grid.inBounds(cx, 1, cz))
      grid.set(cx, 1, cz, 'minecraft:enchanting_table');
    // Bookshelves surrounding enchanting table (full ring)
    for (const [bdx, bdz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      if (grid.inBounds(cx + bdx, 1, cz + bdz))
        grid.set(cx + bdx, 1, cz + bdz, 'minecraft:bookshelf');
      if (grid.inBounds(cx + bdx, 2, cz + bdz))
        grid.set(cx + bdx, 2, cz + bdz, 'minecraft:bookshelf');
    }
    // Amethyst crystal clusters on exterior walls (magical glow)
    for (let story = 0; story < floors; story++) {
      const crystalY = story * STORY_H + 3;
      for (const [cdx, cdz] of [[radius + 1, 0], [-(radius + 1), 0], [0, radius + 1], [0, -(radius + 1)]]) {
        if (grid.inBounds(cx + cdx, crystalY, cz + cdz))
          grid.set(cx + cdx, crystalY, cz + cdz, 'minecraft:amethyst_cluster[facing=up]');
      }
    }
    // Brewing stands on upper floors
    const brewY = STORY_H + 1;
    if (grid.inBounds(cx - 2, brewY, cz + 2))
      grid.set(cx - 2, brewY, cz + 2, 'minecraft:brewing_stand');
    // Cauldron with potion
    if (grid.inBounds(cx + 2, brewY, cz - 2))
      grid.set(cx + 2, brewY, cz - 2, 'minecraft:water_cauldron[level=3]');
    // End rod spire on very top — taller crystal beacon (6 blocks)
    const spireBase = floors * STORY_H + 1;
    for (let sy = spireBase; sy <= spireBase + 5; sy++) {
      if (grid.inBounds(cx, sy, cz))
        grid.set(cx, sy, cz, 'minecraft:end_rod[facing=up]');
    }
    // Amethyst crown at spire base
    for (const [sdx, sdz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (grid.inBounds(cx + sdx, spireBase, cz + sdz))
        grid.set(cx + sdx, spireBase, cz + sdz, 'minecraft:amethyst_block');
    }
    // Floating end rod orbiting lights
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2;
      const orbitR = radius + 3;
      const ox = cx + Math.round(Math.cos(angle) * orbitR);
      const oz = cz + Math.round(Math.sin(angle) * orbitR);
      const oy = Math.floor(floors * STORY_H * 0.7);
      if (grid.inBounds(ox, oy, oz))
        grid.set(ox, oy, oz, 'minecraft:end_rod[facing=up]');
    }
  }

  // ── Surrounding wall + guard hut — all towers get compositional complexity ──
  const wallR = radius + margin - 1; // Wall around perimeter
  const wallH = 3;
  // Circular perimeter wall
  for (let dx = -wallR; dx <= wallR; dx++) {
    for (let dz = -wallR; dz <= wallR; dz++) {
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= wallR - 0.5 && dist <= wallR + 0.5) {
        const wx = cx + dx;
        const wz = cz + dz;
        if (!grid.inBounds(wx, 0, wz)) continue;
        for (let y = 1; y <= wallH; y++) {
          grid.set(wx, y, wz, style.wall);
        }
        // Crenellations
        if ((dx + dz) % 3 === 0 && grid.inBounds(wx, wallH + 1, wz))
          grid.set(wx, wallH + 1, wz, style.wall);
      }
    }
  }
  // Gate opening (toward south / high-Z = isometric-facing)
  for (let dx = -1; dx <= 1; dx++) {
    for (let y = 1; y <= wallH; y++) {
      const gx = cx + dx;
      const gz = cz + wallR;
      if (grid.inBounds(gx, y, gz)) grid.set(gx, y, gz, 'minecraft:air');
    }
  }
  // Gate pillars
  for (let y = 1; y <= wallH + 1; y++) {
    if (grid.inBounds(cx - 2, y, cz + wallR)) grid.set(cx - 2, y, cz + wallR, style.wallAccent);
    if (grid.inBounds(cx + 2, y, cz + wallR)) grid.set(cx + 2, y, cz + wallR, style.wallAccent);
  }
  // Small guard hut near gate (SE of tower)
  const ghX = cx + wallR - 4;
  const ghZ = cz + wallR - 4;
  if (grid.inBounds(ghX + 3, 0, ghZ + 3)) {
    placeOutbuilding(grid, ghX, ghZ, 4, 4, 3, style, 'flat');
  }
  // Lanterns on wall at cardinal points
  for (const [lx, lz] of [[cx, cz - wallR + 1], [cx + wallR - 1, cz], [cx - wallR + 1, cz]] as [number, number][]) {
    if (grid.inBounds(lx, wallH + 1, lz))
      grid.set(lx, wallH + 1, lz, style.lanternFloor);
  }
  // Path from gate to tower entrance
  for (let dz = 1; dz <= wallR - radius - 1; dz++) {
    if (grid.inBounds(cx, 0, cz + radius + dz))
      grid.set(cx, 0, cz + radius + dz, 'minecraft:cobblestone');
  }

  return grid;
}

// ─── Castle ─────────────────────────────────────────────────────────────────

function generateCastle(
  floors: number, style: StylePalette, rooms: RoomType[] | undefined,
  bwOpt: number | undefined, blOpt: number | undefined, rng: () => number
): BlockGrid {
  const bw = bwOpt ?? 41;
  const bl = blOpt ?? 35;
  const margin = 5;
  const towerRadius = 4;
  const gw = bw + margin * 2;
  const gl = bl + margin * 2;
  const gh = floors * STORY_H + ROOF_H + 10;

  const bx1 = margin;
  const bx2 = margin + bw - 1;
  const bz1 = margin;
  const bz2 = margin + bl - 1;
  const xMid = margin + Math.floor(bw / 2);
  const zMid = margin + Math.floor(bl / 2);

  const grid = new BlockGrid(gw, gh, gl);

  // === Courtyard walls ===
  // Foundation
  foundation(grid, bx1, bz1, bx2, bz2, style);

  // Outer curtain walls (full height of first floor only for walls)
  const wallH = STORY_H + 2;
  for (let y = 1; y <= wallH; y++) {
    for (let x = bx1; x <= bx2; x++) {
      grid.set(x, y, bz1, style.wall);
      grid.set(x, y, bz2, style.wall);
    }
    for (let z = bz1; z <= bz2; z++) {
      grid.set(bx1, y, z, style.wall);
      grid.set(bx2, y, z, style.wall);
    }
  }

  // Battlements on curtain walls
  for (let x = bx1; x <= bx2; x += 2) {
    grid.set(x, wallH + 1, bz1, style.wall);
    grid.set(x, wallH + 1, bz2, style.wall);
  }
  for (let z = bz1; z <= bz2; z += 2) {
    grid.set(bx1, wallH + 1, z, style.wall);
    grid.set(bx2, wallH + 1, z, style.wall);
  }

  // ── Wall buttresses — pilasters every 5 blocks for facade depth ──
  for (let x = bx1 + 5; x <= bx2 - 5; x += 5) {
    for (let y = 1; y <= wallH; y++) {
      // North wall buttress (protrudes outward)
      if (grid.inBounds(x, y, bz1 - 1))
        grid.set(x, y, bz1 - 1, style.wallAccent);
      // South wall buttress
      if (grid.inBounds(x, y, bz2 + 1))
        grid.set(x, y, bz2 + 1, style.wallAccent);
    }
  }
  for (let z = bz1 + 5; z <= bz2 - 5; z += 5) {
    for (let y = 1; y <= wallH; y++) {
      if (grid.inBounds(bx1 - 1, y, z))
        grid.set(bx1 - 1, y, z, style.wallAccent);
      if (grid.inBounds(bx2 + 1, y, z))
        grid.set(bx2 + 1, y, z, style.wallAccent);
    }
  }

  // Walkway along wall tops
  grid.fill(bx1 + 1, wallH, bz1, bx1 + 2, wallH, bz2, style.floorUpper);
  grid.fill(bx2 - 2, wallH, bz1, bx2 - 1, wallH, bz2, style.floorUpper);
  grid.fill(bx1, wallH, bz1 + 1, bx2, wallH, bz1 + 2, style.floorUpper);
  grid.fill(bx1, wallH, bz2 - 2, bx2, wallH, bz2 - 1, style.floorUpper);

  // Windows along walls
  for (let x = bx1 + 4; x < bx2 - 2; x += 4) {
    grid.set(x, 3, bz1, style.window);
    grid.set(x, 4, bz1, style.window);
    grid.set(x, 3, bz2, style.window);
    grid.set(x, 4, bz2, style.window);
  }
  for (let z = bz1 + 4; z < bz2 - 2; z += 4) {
    grid.set(bx1, 3, z, style.window);
    grid.set(bx1, 4, z, style.window);
    grid.set(bx2, 3, z, style.window);
    grid.set(bx2, 4, z, style.window);
  }

  // === Corner towers ===
  const towerCorners: [number, number][] = [
    [bx1, bz1], [bx2, bz1], [bx1, bz2], [bx2, bz2],
  ];
  const towerH = floors * STORY_H + 4;
  for (const [tcx, tcz] of towerCorners) {
    for (let y = 0; y <= towerH; y++) {
      // Fill entire circle then hollow interior (gap-free 2-thick walls)
      for (let dx = -towerRadius; dx <= towerRadius; dx++) {
        for (let dz = -towerRadius; dz <= towerRadius; dz++) {
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist <= towerRadius + 0.5) {
            const tx = tcx + dx;
            const tz = tcz + dz;
            if (!grid.inBounds(tx, y, tz)) continue;
            if (y === 0) {
              grid.set(tx, y, tz, style.foundation);
            } else {
              grid.set(tx, y, tz, style.wall);
            }
          }
        }
      }
      // Hollow out interior
      if (y > 0) {
        for (let dx = -(towerRadius - 2); dx <= towerRadius - 2; dx++) {
          for (let dz = -(towerRadius - 2); dz <= towerRadius - 2; dz++) {
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist <= towerRadius - 2 + 0.5) {
              const tx = tcx + dx;
              const tz = tcz + dz;
              if (!grid.inBounds(tx, y, tz)) continue;
              if (y % STORY_H === 0) {
                grid.set(tx, y, tz, style.floorUpper);
              } else {
                grid.set(tx, y, tz, 'minecraft:air');
              }
            }
          }
        }
      }
    }
    // Tower battlements
    for (let dx = -towerRadius - 1; dx <= towerRadius + 1; dx++) {
      for (let dz = -towerRadius - 1; dz <= towerRadius + 1; dz++) {
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist >= towerRadius - 0.5 && dist <= towerRadius + 1.5) {
          const tx = tcx + dx;
          const tz = tcz + dz;
          if (grid.inBounds(tx, towerH + 1, tz)) {
            grid.set(tx, towerH + 1, tz, style.wall);
            if ((dx + dz) % 3 === 0 && grid.inBounds(tx, towerH + 2, tz)) {
              grid.set(tx, towerH + 2, tz, style.wall);
            }
          }
        }
      }
    }
    // Tower cone roof
    for (let layer = 0; layer <= towerRadius + 1; layer++) {
      const ry = towerH + 2 + layer;
      const rr = towerRadius - layer;
      if (rr <= 0 || !grid.inBounds(0, ry, 0)) break;
      for (let dx = -rr; dx <= rr; dx++) {
        for (let dz = -rr; dz <= rr; dz++) {
          if (Math.sqrt(dx * dx + dz * dz) <= rr + 0.5) {
            const tx = tcx + dx;
            const tz = tcz + dz;
            if (grid.inBounds(tx, ry, tz)) {
              grid.set(tx, ry, tz, style.roofS);
            }
          }
        }
      }
    }
  }

  // === Main keep (central building) — tall stone fortress, not a house ===
  const keepW = Math.floor(bw * 0.5);
  const keepL = Math.floor(bl * 0.45);
  const kx1 = xMid - Math.floor(keepW / 2);
  const kx2 = kx1 + keepW - 1;
  const kz1 = zMid - Math.floor(keepL / 2);
  const kz2 = kz1 + keepL - 1;
  const keepFloors = Math.max(floors, 2); // keep is always at least 2 stories

  for (let story = 0; story < keepFloors; story++) {
    const by = story * STORY_H;
    const cy = by + STORY_H;

    // Keep foundation and floor — stone, not wood
    grid.fill(kx1, by, kz1, kx2, by, kz2, story === 0 ? style.foundation : style.floorUpper);

    // Thick stone walls (2-block-thick for castle feel)
    for (let y = by + 1; y <= cy - 1; y++) {
      for (let x = kx1; x <= kx2; x++) {
        for (let z = kz1; z <= kz2; z++) {
          const onOuterWall = x === kx1 || x === kx2 || z === kz1 || z === kz2;
          const onInnerWall = x === kx1 + 1 || x === kx2 - 1 || z === kz1 + 1 || z === kz2 - 1;
          if (onOuterWall || onInnerWall) {
            grid.set(x, y, z, style.wall);
          }
        }
      }
    }

    // Pillar buttresses at corners and midpoints (projecting outward)
    const keepPillars: [number, number][] = [
      [kx1, kz1], [kx2, kz1], [kx1, kz2], [kx2, kz2],
      [xMid, kz1], [xMid, kz2], [kx1, zMid], [kx2, zMid],
    ];
    for (const [px, pz] of keepPillars) {
      for (let y = by; y <= cy; y++) {
        if (grid.inBounds(px, y, pz)) grid.set(px, y, pz, style.wallAccent);
      }
    }

    // Narrow slit windows (1-block tall) at intervals — fortified, not residential
    for (let x = kx1 + 4; x <= kx2 - 4; x += 4) {
      if (grid.inBounds(x, by + 3, kz1)) grid.set(x, by + 3, kz1, 'minecraft:air');
      if (grid.inBounds(x, by + 3, kz2)) grid.set(x, by + 3, kz2, 'minecraft:air');
    }
    for (let z = kz1 + 4; z <= kz2 - 4; z += 4) {
      if (grid.inBounds(kx1, by + 3, z)) grid.set(kx1, by + 3, z, 'minecraft:air');
      if (grid.inBounds(kx2, by + 3, z)) grid.set(kx2, by + 3, z, 'minecraft:air');
    }

    if (story === 0) {
      // ── Ground floor: Grand Hall with double-height feel ──
      // Stone colonnade — heavy pillars flanking central aisle
      const colSpacing = Math.max(4, Math.floor(keepW / 4));
      for (let x = kx1 + colSpacing; x < kx2 - 2; x += colSpacing) {
        for (const pz of [kz1 + 3, kz2 - 3]) {
          for (let y = by; y <= cy; y++) {
            if (grid.inBounds(x, y, pz)) grid.set(x, y, pz, style.wallAccent);
          }
        }
      }

      // Raised dais at far end (high-Z, 2 blocks high platform)
      const daisZ1 = kz2 - 5;
      grid.fill(kx1 + 3, by, daisZ1, kx2 - 3, by + 1, kz2 - 2, style.wallAccent);
      // Throne on dais
      grid.set(xMid, by + 2, kz2 - 3, style.chairN);
      // Gold accents flanking throne
      for (const dx of [-2, -1, 1, 2]) {
        if (grid.inBounds(xMid + dx, by + 2, kz2 - 3))
          grid.set(xMid + dx, by + 2, kz2 - 3, 'minecraft:gold_block');
      }
      // Banner wall behind throne
      for (let dx = -3; dx <= 3; dx++) {
        if (grid.inBounds(xMid + dx, by + 3, kz2 - 2))
          grid.set(xMid + dx, by + 3, kz2 - 2, style.bannerN);
        if (grid.inBounds(xMid + dx, by + 4, kz2 - 2))
          grid.set(xMid + dx, by + 4, kz2 - 2, style.bannerN);
      }

      // Wide carpet runner (3 blocks) down center of hall
      for (let z = kz1 + 3; z < daisZ1; z++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (grid.inBounds(xMid + dx, by, z))
            grid.set(xMid + dx, by, z, 'minecraft:red_carpet');
        }
      }

      // Chandeliers over the hall (multiple, spaced along length)
      for (let z = kz1 + 4; z < kz2 - 4; z += Math.floor(keepL / 3)) {
        chandelier(grid, xMid, cy - 1, z, style, 2);
      }

      // Grand entrance — 5-wide arched opening on low-Z face toward courtyard
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = by + 1; dy <= by + 4; dy++) {
          if (grid.inBounds(xMid + dx, dy, kz1))
            grid.set(xMid + dx, dy, kz1, 'minecraft:air');
          if (grid.inBounds(xMid + dx, dy, kz1 + 1))
            grid.set(xMid + dx, dy, kz1 + 1, 'minecraft:air');
        }
      }
      // Arch keystone above entrance
      for (let dx = -2; dx <= 2; dx++) {
        if (grid.inBounds(xMid + dx, by + 4, kz1))
          grid.set(xMid + dx, by + 4, kz1, style.wallAccent);
      }
    } else {
      // ── Upper floors: large open rooms, no house-like quad layout ──
      // Single dividing wall creating two chambers (war room + barracks feel)
      const divZ = zMid + (story % 2 === 0 ? -2 : 2); // offset each floor
      interiorWall(grid, 'x', divZ, kx1 + 2, kx2 - 2, by + 1, cy - 1, style);
      doorway(grid, xMid - 1, by + 1, divZ, xMid + 1, by + 3, divZ);
    }

    // Ceiling
    if (story === keepFloors - 1) {
      grid.fill(kx1, cy, kz1, kx2, cy, kz2, style.ceiling);
    }

    // Wall-mounted torches (sparse, using iron brackets)
    wallTorches(grid, kx1 + 1, kz1 + 1, kx2 - 1, kz2 - 1, by + 3, style);
  }

  // Keep battlements on top
  const keepTopY = keepFloors * STORY_H;
  for (let x = kx1 - 1; x <= kx2 + 1; x++) {
    for (let z = kz1 - 1; z <= kz2 + 1; z++) {
      const onEdge = x <= kx1 || x >= kx2 || z <= kz1 || z >= kz2;
      if (!onEdge) continue;
      if (grid.inBounds(x, keepTopY + 1, z)) {
        grid.set(x, keepTopY + 1, z, style.wall);
        // Crenellations: alternating merlons
        if ((x + z) % 2 === 0 && grid.inBounds(x, keepTopY + 2, z)) {
          grid.set(x, keepTopY + 2, z, style.wall);
        }
      }
    }
  }

  // Keep staircase (spiral in corner, not central)
  for (let story = 0; story < keepFloors - 1; story++) {
    staircase(grid, kx2 - 4, kx2 - 3, kz1 + 2, story * STORY_H, (story + 1) * STORY_H, gh);
  }

  // Keep rooms — upper floors only (ground floor is open great hall)
  const roomAssignment = resolveRooms(keepFloors, rooms, rng, 'castle');
  for (let story = 1; story < keepFloors; story++) {
    const by = story * STORY_H;
    const fy = by + 1;
    const storyRooms = roomAssignment[story];
    // Two chambers divided by wall (front/back, not left/right like a house)
    const divZ = zMid + (story % 2 === 0 ? -2 : 2);
    const chambers: RoomBounds[] = [
      { x1: kx1 + 2, y: fy, z1: kz1 + 2, x2: kx2 - 2, z2: divZ - 1, height: STORY_H - 1 },
      { x1: kx1 + 2, y: fy, z1: divZ + 1, x2: kx2 - 2, z2: kz2 - 2, height: STORY_H - 1 },
    ];
    for (let h = 0; h < Math.min(storyRooms.length, chambers.length); h++) {
      getRoomGenerator(storyRooms[h])(grid, chambers[h], style);
    }
  }

  // Keep roof — flat battlement top, no gabled house-style roof
  // (battlements already placed above)

  // Gatehouse entrance (on high-Z side to catch isometric light)
  const gateX = xMid;
  grid.set(gateX - 1, 1, bz2, style.doorLowerN);
  grid.set(gateX - 1, 2, bz2, style.doorUpperN);
  grid.set(gateX, 1, bz2, style.doorLowerN);
  grid.set(gateX, 2, bz2, style.doorUpperN);
  grid.set(gateX + 1, 1, bz2, 'minecraft:air');
  grid.set(gateX + 1, 2, bz2, 'minecraft:air');
  grid.set(gateX + 1, 3, bz2, 'minecraft:air');
  grid.set(gateX - 1, 3, bz2, 'minecraft:air');
  grid.set(gateX, 3, bz2, 'minecraft:air');

  // Courtyard floor
  grid.fill(bx1 + 3, 0, bz1 + 3, bx2 - 3, 0, bz2 - 3, style.floorGround);

  // Courtyard path (cross pattern from gate to keep)
  for (let z = bz1 + 3; z <= bz2 - 3; z++) {
    grid.set(xMid - 1, 0, z, 'minecraft:polished_deepslate');
    grid.set(xMid, 0, z, 'minecraft:polished_deepslate');
    grid.set(xMid + 1, 0, z, 'minecraft:polished_deepslate');
  }
  for (let x = bx1 + 3; x <= bx2 - 3; x++) {
    grid.set(x, 0, zMid, 'minecraft:polished_deepslate');
  }

  // Well (center of courtyard near gate side)
  const wellX = xMid;
  const wellZ = bz2 - 6;
  grid.fill(wellX - 1, 0, wellZ - 1, wellX + 1, 0, wellZ + 1, 'minecraft:stone_bricks');
  grid.set(wellX, 0, wellZ, 'minecraft:water_cauldron[level=3]');
  for (const [wx, wz] of [[wellX - 1, wellZ - 1], [wellX + 1, wellZ - 1],
                            [wellX - 1, wellZ + 1], [wellX + 1, wellZ + 1]]) {
    grid.set(wx, 1, wz, style.fence);
    grid.set(wx, 2, wz, style.fence);
  }
  // Well roof
  grid.fill(wellX - 1, 3, wellZ - 1, wellX + 1, 3, wellZ + 1, style.slabBottom);
  grid.set(wellX, 2, wellZ, 'minecraft:chain');
  grid.set(wellX, 1, wellZ, style.lanternFloor);

  // Training grounds (NW quadrant of courtyard)
  const trainX = bx1 + 6;
  const trainZ = bz1 + 6;
  // Training dummy (hay + target)
  grid.set(trainX, 1, trainZ, 'minecraft:hay_block');
  grid.set(trainX, 2, trainZ, 'minecraft:target');
  grid.set(trainX, 3, trainZ, 'minecraft:carved_pumpkin[facing=south]');
  // Weapon rack
  grid.set(trainX + 2, 1, trainZ, 'minecraft:grindstone[face=floor,facing=north]');
  grid.set(trainX + 3, 1, trainZ, 'minecraft:anvil[facing=north]');

  // Market stalls (SE quadrant of courtyard)
  const stallX = bx2 - 8;
  const stallZ = bz2 - 8;
  // Stall 1: merchant table
  grid.set(stallX, 1, stallZ, style.fence);
  grid.set(stallX, 2, stallZ, 'minecraft:white_carpet');
  grid.set(stallX + 1, 1, stallZ, style.fence);
  grid.set(stallX + 1, 2, stallZ, 'minecraft:white_carpet');
  grid.set(stallX + 2, 1, stallZ, style.chairW);
  // Stall roof
  grid.fill(stallX - 1, 3, stallZ - 1, stallX + 2, 3, stallZ + 1, style.slabBottom);
  // Stall 2: hay bales and barrels
  grid.set(stallX, 1, stallZ + 3, 'minecraft:hay_block');
  grid.set(stallX + 1, 1, stallZ + 3, 'minecraft:hay_block');
  grid.set(stallX, 2, stallZ + 3, 'minecraft:hay_block');
  grid.addBarrel(stallX + 2, 1, stallZ + 3, 'up', [
    { slot: 0, id: 'minecraft:apple', count: 32 },
  ]);

  // Torches in courtyard (along paths)
  for (let x = bx1 + 5; x < bx2 - 3; x += 5) {
    grid.set(x, 1, bz1 + 3, style.lanternFloor);
    grid.set(x, 1, bz2 - 3, style.lanternFloor);
  }
  for (let z = bz1 + 5; z < bz2 - 3; z += 5) {
    grid.set(bx1 + 3, 1, z, style.lanternFloor);
    grid.set(bx2 - 3, 1, z, style.lanternFloor);
  }

  // Banners on courtyard walls
  grid.set(xMid - 3, 4, bz1, style.bannerS);
  grid.set(xMid + 3, 4, bz1, style.bannerS);
  grid.set(xMid - 3, 4, bz2, style.bannerN);
  grid.set(xMid + 3, 4, bz2, style.bannerN);

  // Courtyard trees for greenery
  const treePosC: [number, number][] = [
    [bx1 + 8, bz2 - 6], [bx2 - 8, bz1 + 8],
  ];
  for (const [tx, tz] of treePosC) {
    if (grid.inBounds(tx, 1, tz)) placeTree(grid, tx, 1, tz, 'oak', 4);
  }

  // Guard armor stands near tower bases
  for (const [tcx, tcz] of [[bx1 + 2, bz1 + 2], [bx2 - 2, bz1 + 2], [bx2 - 2, bz2 - 2]] as [number, number][]) {
    if (grid.inBounds(tcx, 1, tcz))
      grid.set(tcx, 1, tcz, 'minecraft:armor_stand');
  }

  // ── Varied tower heights — alternating tall/short for interesting skyline ──
  // Front-right and back-left towers get extra height (2 blocks)
  for (const [tcx, tcz] of [[bx2, bz1], [bx1, bz2]] as [number, number][]) {
    const extraH = 2;
    for (let dx = -towerRadius; dx <= towerRadius; dx++) {
      for (let dz = -towerRadius; dz <= towerRadius; dz++) {
        if (Math.sqrt(dx * dx + dz * dz) <= towerRadius + 0.5) {
          const tx = tcx + dx;
          const tz = tcz + dz;
          for (let y = towerH + 1; y <= towerH + extraH; y++) {
            if (grid.inBounds(tx, y, tz)) grid.set(tx, y, tz, style.wall);
          }
        }
      }
    }
  }

  // ── Courtyard garden patches — break up flat ground ──
  // Grass patch with flowers (SW quadrant)
  const gardenCX = bx1 + 5;
  const gardenCZ = bz2 - 5;
  for (let dx = 0; dx < 3; dx++) {
    for (let dz = 0; dz < 3; dz++) {
      if (grid.inBounds(gardenCX + dx, 0, gardenCZ + dz))
        grid.set(gardenCX + dx, 0, gardenCZ + dz, 'minecraft:grass_block');
    }
  }
  const flowers = ['minecraft:poppy', 'minecraft:dandelion', 'minecraft:cornflower', 'minecraft:azure_bluet'];
  for (let i = 0; i < 4; i++) {
    const fx = gardenCX + Math.floor(rng() * 3);
    const fz = gardenCZ + Math.floor(rng() * 3);
    if (grid.inBounds(fx, 1, fz))
      grid.set(fx, 1, fz, flowers[i % flowers.length]);
  }

  // ── Stable area (NE quadrant) — horse stalls ──
  const stableX = bx2 - 6;
  const stableZ = bz1 + 4;
  // Stable roof (slab overhang)
  grid.fill(stableX, 3, stableZ, stableX + 3, 3, stableZ + 2, style.slabBottom);
  // Fence stall dividers
  for (let dz = 0; dz <= 2; dz++) {
    if (grid.inBounds(stableX, 1, stableZ + dz))
      grid.set(stableX, 1, stableZ + dz, style.fence);
    if (grid.inBounds(stableX + 3, 1, stableZ + dz))
      grid.set(stableX + 3, 1, stableZ + dz, style.fence);
  }
  // Hay feeder
  if (grid.inBounds(stableX + 1, 1, stableZ))
    grid.set(stableX + 1, 1, stableZ, 'minecraft:hay_block');

  // ── Castle wall weathering — aged stone with moss/cracks ──
  const castleVariants = [
    'minecraft:mossy_stone_bricks', 'minecraft:cracked_stone_bricks',
    'minecraft:cobblestone',
  ];
  // Outer curtain walls only
  weatherWalls(grid, bx1, 0, bz1, bx2, wallH + 2, bz2, style.wall, castleVariants, rng, 0.12);

  // ── Additional courtyard life — weapon rack, archery targets ──
  // Weapon rack (armor stand + sword display)
  const rackX = bx1 + 5;
  const rackZ = bz1 + 5;
  if (grid.inBounds(rackX, 1, rackZ))
    grid.set(rackX, 1, rackZ, 'minecraft:armor_stand');
  if (grid.inBounds(rackX + 1, 1, rackZ))
    grid.set(rackX + 1, 1, rackZ, 'minecraft:grindstone[face=floor,facing=north]');
  // Archery target (hay bale)
  const targetX = bx2 - 5;
  const targetZ = bz1 + 5;
  if (grid.inBounds(targetX, 1, targetZ))
    grid.set(targetX, 1, targetZ, 'minecraft:hay_block');
  if (grid.inBounds(targetX, 2, targetZ))
    grid.set(targetX, 2, targetZ, 'minecraft:target');

  // More banners along inner curtain walls for heraldic density
  for (let x = bx1 + 6; x <= bx2 - 6; x += 8) {
    if (grid.inBounds(x, wallH, bz1 + 1))
      grid.set(x, wallH, bz1 + 1, style.bannerS);
    if (grid.inBounds(x, wallH, bz2 - 1))
      grid.set(x, wallH, bz2 - 1, style.bannerN);
  }

  // ── Dark Fortress (gothic) unique features — angular, menacing silhouette ──
  if (style.wall === 'minecraft:deepslate_bricks') {
    // Pointed spires on corner towers (replace cone tops with sharp points)
    for (const [tcx, tcz] of towerCorners) {
      const spireTop = towerH + towerRadius + 4;
      for (let y = towerH + 3; y <= spireTop; y++) {
        if (grid.inBounds(tcx, y, tcz))
          grid.set(tcx, y, tcz, 'minecraft:blackstone');
      }
      // Glowing soul fire at spire tip
      if (grid.inBounds(tcx, spireTop + 1, tcz))
        grid.set(tcx, spireTop + 1, tcz, 'minecraft:soul_lantern[hanging=false]');
    }
    // Lava moat channels around exterior (visible as red glow)
    for (let x = bx1 - 2; x <= bx2 + 2; x++) {
      for (const mz of [bz1 - 2, bz2 + 2]) {
        if (grid.inBounds(x, 0, mz))
          grid.set(x, 0, mz, 'minecraft:lava');
      }
    }
    for (let z = bz1 - 2; z <= bz2 + 2; z++) {
      for (const mx of [bx1 - 2, bx2 + 2]) {
        if (grid.inBounds(mx, 0, z))
          grid.set(mx, 0, z, 'minecraft:lava');
      }
    }
    // Soul torches replacing regular torches for eerie blue light
    for (let x = bx1 + 5; x < bx2 - 3; x += 5) {
      if (grid.inBounds(x, 1, bz1 + 3))
        grid.set(x, 1, bz1 + 3, 'minecraft:soul_lantern[hanging=false]');
      if (grid.inBounds(x, 1, bz2 - 3))
        grid.set(x, 1, bz2 - 3, 'minecraft:soul_lantern[hanging=false]');
    }
    // Skull decorations on gatehouse
    if (grid.inBounds(xMid - 2, wallH, bz2))
      grid.set(xMid - 2, wallH, bz2, 'minecraft:wither_skeleton_skull[rotation=0]');
    if (grid.inBounds(xMid + 2, wallH, bz2))
      grid.set(xMid + 2, wallH, bz2, 'minecraft:wither_skeleton_skull[rotation=0]');
    // Cobweb curtains in gatehouse entrance
    if (grid.inBounds(xMid, 3, bz2 - 1))
      grid.set(xMid, 3, bz2 - 1, 'minecraft:cobweb');
  }

  return grid;
}

// ─── Dungeon ────────────────────────────────────────────────────────────────

function generateDungeon(
  floors: number, style: StylePalette, rooms: RoomType[] | undefined,
  bwOpt: number | undefined, blOpt: number | undefined, rng: () => number
): BlockGrid {
  const bw = bwOpt ?? 25;
  const bl = blOpt ?? 25;
  const margin = 3;
  const gw = bw + margin * 2;
  const gl = bl + margin * 2;
  // Dungeons go DOWN — floors below ground level
  const gh = STORY_H + floors * STORY_H + 5;
  const groundY = floors * STORY_H;

  const bx1 = margin;
  const bx2 = margin + bw - 1;
  const bz1 = margin;
  const bz2 = margin + bl - 1;
  const xMid = margin + Math.floor(bw / 2);
  const zMid = margin + Math.floor(bl / 2);

  const grid = new BlockGrid(gw, gh, gl);

  // Ground surface — leave open only around entrance area, fill rest with foundation
  grid.fill(bx1, groundY, bz1, bx2, groundY, bz2, style.foundation);

  // Surface entrance — larger gatehouse-style structure with towers
  const entrW = 11;
  const entrD = 9;
  const ex1 = xMid - Math.floor(entrW / 2);
  const ex2 = ex1 + entrW - 1;
  const ez1 = bz1;
  const ez2 = bz1 + entrD - 1;
  const entrH = STORY_H + 3; // Taller entrance

  // Entrance walls
  for (let y = groundY + 1; y <= groundY + entrH; y++) {
    exteriorWalls(grid, ex1, y, ez1, ex2, y, ez2, style);
  }
  // Floor inside
  grid.fill(ex1 + 1, groundY, ez1 + 1, ex2 - 1, groundY, ez2 - 1, style.floorGround);
  // Flat roof
  grid.fill(ex1, groundY + entrH, ez1, ex2, groundY + entrH, ez2, style.ceiling);

  // Battlements on entrance roof
  for (let x = ex1; x <= ex2; x += 2) {
    if (grid.inBounds(x, groundY + entrH + 1, ez1)) {
      grid.set(x, groundY + entrH + 1, ez1, style.wall);
    }
    if (grid.inBounds(x, groundY + entrH + 1, ez2)) {
      grid.set(x, groundY + entrH + 1, ez2, style.wall);
    }
  }
  for (let z = ez1; z <= ez2; z += 2) {
    if (grid.inBounds(ex1, groundY + entrH + 1, z)) {
      grid.set(ex1, groundY + entrH + 1, z, style.wall);
    }
    if (grid.inBounds(ex2, groundY + entrH + 1, z)) {
      grid.set(ex2, groundY + entrH + 1, z, style.wall);
    }
  }

  // Mini towers at entrance corners
  const towerR = 2;
  for (const [tcx, tcz] of [[ex1, ez1], [ex2, ez1], [ex1, ez2], [ex2, ez2]] as [number, number][]) {
    for (let y = groundY + 1; y <= groundY + entrH + 2; y++) {
      for (let dx = -towerR; dx <= towerR; dx++) {
        for (let dz = -towerR; dz <= towerR; dz++) {
          if (Math.sqrt(dx * dx + dz * dz) <= towerR + 0.5) {
            const tx = tcx + dx;
            const tz = tcz + dz;
            if (grid.inBounds(tx, y, tz)) {
              grid.set(tx, y, tz, style.wall);
            }
          }
        }
      }
    }
    // Cone top on mini towers
    for (let layer = 0; layer <= towerR; layer++) {
      const ry = groundY + entrH + 3 + layer;
      const rr = towerR - layer;
      if (rr <= 0) break;
      for (let dx = -rr; dx <= rr; dx++) {
        for (let dz = -rr; dz <= rr; dz++) {
          if (Math.sqrt(dx * dx + dz * dz) <= rr + 0.5) {
            const tx = tcx + dx;
            const tz = tcz + dz;
            if (grid.inBounds(tx, ry, tz)) {
              grid.set(tx, ry, tz, style.roofS);
            }
          }
        }
      }
    }
  }

  // Arch entrance (3 blocks wide, 4 tall)
  grid.set(xMid - 1, groundY + 1, ez1, 'minecraft:air');
  grid.set(xMid, groundY + 1, ez1, 'minecraft:air');
  grid.set(xMid + 1, groundY + 1, ez1, 'minecraft:air');
  grid.set(xMid - 1, groundY + 2, ez1, 'minecraft:air');
  grid.set(xMid, groundY + 2, ez1, 'minecraft:air');
  grid.set(xMid + 1, groundY + 2, ez1, 'minecraft:air');
  grid.set(xMid - 1, groundY + 3, ez1, 'minecraft:air');
  grid.set(xMid, groundY + 3, ez1, 'minecraft:air');
  grid.set(xMid + 1, groundY + 3, ez1, 'minecraft:air');
  grid.set(xMid, groundY + 4, ez1, 'minecraft:air');
  // Iron bar gate flanks
  grid.set(xMid - 2, groundY + 1, ez1, 'minecraft:iron_bars');
  grid.set(xMid - 2, groundY + 2, ez1, 'minecraft:iron_bars');
  grid.set(xMid + 2, groundY + 1, ez1, 'minecraft:iron_bars');
  grid.set(xMid + 2, groundY + 2, ez1, 'minecraft:iron_bars');

  // Entrance torches
  grid.set(xMid - 2, groundY + 3, ez1 + 1, style.torchS);
  grid.set(xMid + 2, groundY + 3, ez1 + 1, style.torchS);

  // Windows on entrance sides
  windows(grid, ex1, ez1, ex2, ez2, groundY + 3, groundY + 4, style, 4);

  // Underground levels
  for (let level = 0; level < floors; level++) {
    const by = groundY - (level + 1) * STORY_H;
    if (by < 0) break;
    const cy = by + STORY_H;

    // Dig out chamber
    grid.fill(bx1, by, bz1, bx2, by, bz2, style.floorGround);
    grid.fill(bx1, cy, bz1, bx2, cy, bz2, style.ceiling);
    exteriorWalls(grid, bx1, by + 1, bz1, bx2, cy - 1, bz2, style);

    // Corridors — cross shaped, main N-S corridor is wider (5 blocks)
    const mainHalfC = 2;  // 5-wide main corridor
    const sideHalfC = 1;  // 3-wide side corridors
    // N-S main corridor (wider)
    for (let z = bz1 + 1; z <= bz2 - 1; z++) {
      for (let dx = -mainHalfC; dx <= mainHalfC; dx++) {
        for (let y = by + 1; y < cy; y++) {
          grid.set(xMid + dx, y, z, 'minecraft:air');
        }
      }
    }
    // E-W side corridors (standard width)
    for (let x = bx1 + 1; x <= bx2 - 1; x++) {
      for (let dz = -sideHalfC; dz <= sideHalfC; dz++) {
        for (let y = by + 1; y < cy; y++) {
          grid.set(x, y, zMid + dz, 'minecraft:air');
        }
      }
    }

    // Mossy stone brick floor in corridors
    const floorBlocks = ['minecraft:mossy_stone_bricks', style.floorGround, 'minecraft:cracked_stone_bricks'];
    for (let z = bz1 + 1; z <= bz2 - 1; z++) {
      for (let dx = -mainHalfC; dx <= mainHalfC; dx++) {
        const fx = xMid + dx;
        if (grid.inBounds(fx, by, z)) {
          grid.set(fx, by, z, floorBlocks[(z + dx) % floorBlocks.length]);
        }
      }
    }
    for (let x = bx1 + 1; x <= bx2 - 1; x++) {
      for (let dz = -sideHalfC; dz <= sideHalfC; dz++) {
        const fz = zMid + dz;
        if (grid.inBounds(x, by, fz)) {
          grid.set(x, by, fz, floorBlocks[(x + dz) % floorBlocks.length]);
        }
      }
    }

    // Water drainage channel — water strip along east side of main corridor
    for (let z = bz1 + 3; z <= bz2 - 3; z++) {
      const drainX = xMid + mainHalfC;
      if (grid.inBounds(drainX, by, z)) {
        // Alternate between water and slab covers
        if (z % 3 === 0) {
          grid.set(drainX, by, z, style.slabBottom);
        } else {
          grid.set(drainX, by, z, 'minecraft:water');
        }
      }
    }

    // Varied room sizes — asymmetric quadrant insets (2 large, 2 small)
    const smallInset = 3;
    const largeInset = 1;
    // Quadrants 0,2 are large; 1,3 are small for spatial hierarchy
    const quadrants: RoomBounds[] = [
      { x1: bx1 + largeInset, y: by + 1, z1: bz1 + largeInset,
        x2: xMid - mainHalfC - 1, z2: zMid - sideHalfC - 1, height: STORY_H - 1 },
      { x1: bx1 + smallInset, y: by + 1, z1: zMid + sideHalfC + 1,
        x2: xMid - mainHalfC - 1, z2: bz2 - smallInset, height: STORY_H - 1 },
      { x1: xMid + mainHalfC + 1, y: by + 1, z1: zMid + sideHalfC + 1,
        x2: bx2 - largeInset, z2: bz2 - largeInset, height: STORY_H - 1 },
      { x1: xMid + mainHalfC + 1, y: by + 1, z1: bz1 + smallInset,
        x2: bx2 - smallInset, z2: zMid - sideHalfC - 1, height: STORY_H - 1 },
    ];

    // Clear chamber interiors
    for (const q of quadrants) {
      for (let y = q.y; y < q.y + q.height; y++) {
        for (let x = q.x1; x <= q.x2; x++) {
          for (let z = q.z1; z <= q.z2; z++) {
            grid.set(x, y, z, 'minecraft:air');
          }
        }
      }
    }

    // Furnish rooms
    const dungeonRooms: RoomType[] = ['vault', 'armory', 'forge', 'lab', 'library', 'throne'];
    const levelRooms = rooms?.slice(level * 4, level * 4 + 4)
      ?? Array.from({ length: 4 }, () => pick(dungeonRooms, rng));
    for (let q = 0; q < Math.min(levelRooms.length, quadrants.length); q++) {
      getRoomGenerator(levelRooms[q])(grid, quadrants[q], style);
    }

    // Staircase down to next level
    if (level < floors - 1) {
      staircase(grid, xMid + 1, xMid + 2, bz1 + 3, by - STORY_H, by, gh);
    }

    // Torch wayfinding — paired torches in main corridor, single in side
    for (let z = bz1 + 3; z < bz2 - 2; z += 4) {
      // Paired torches on main corridor walls
      grid.set(xMid + mainHalfC + 1, by + 3, z, style.torchW);
      grid.set(xMid - mainHalfC - 1, by + 3, z, style.torchE);
    }
    for (let x = bx1 + 3; x < bx2 - 2; x += 6) {
      // Single torches in side corridors (sparser)
      grid.set(x, by + 3, zMid + sideHalfC + 1, style.torchN);
      grid.set(x, by + 3, zMid - sideHalfC - 1, style.torchS);
    }
    // Redstone torch markers every 9 blocks in main corridor
    for (let z = bz1 + 5; z < bz2 - 4; z += 9) {
      if (grid.inBounds(xMid - mainHalfC - 1, by + 2, z))
        grid.set(xMid - mainHalfC - 1, by + 2, z, 'minecraft:redstone_wall_torch[facing=east]');
    }

    // Corridor atmosphere: cobwebs in upper corners (side corridors only)
    for (let x = bx1 + 2; x < bx2 - 1; x += 3) {
      if (grid.inBounds(x, cy - 1, zMid + sideHalfC))
        grid.set(x, cy - 1, zMid + sideHalfC, 'minecraft:cobweb');
      if (grid.inBounds(x, cy - 1, zMid - sideHalfC))
        grid.set(x, cy - 1, zMid - sideHalfC, 'minecraft:cobweb');
    }

    // Chains hanging from ceiling at corridor intersections
    for (let y = by + 2; y < cy; y++) {
      if (grid.inBounds(xMid + mainHalfC, y, zMid))
        grid.set(xMid + mainHalfC, y, zMid, 'minecraft:chain');
      if (grid.inBounds(xMid - mainHalfC, y, zMid))
        grid.set(xMid - mainHalfC, y, zMid, 'minecraft:chain');
    }

    // Iron bar cell doors along N-S corridor walls
    for (let z = bz1 + 5; z < bz2 - 4; z += 7) {
      for (const side of [mainHalfC + 1, -(mainHalfC + 1)]) {
        const bx = xMid + side;
        if (grid.inBounds(bx, by + 1, z)) {
          grid.set(bx, by + 1, z, 'minecraft:iron_bars');
          grid.set(bx, by + 2, z, 'minecraft:iron_bars');
        }
      }
    }

    // Skull/bone decorations near room entrances
    for (const q of quadrants) {
      const entrX = (q.x1 + q.x2) >> 1;
      const entrZ = q.z1 < zMid ? q.z2 + 1 : q.z1 - 1;
      if (grid.inBounds(entrX - 1, by + 1, entrZ))
        grid.set(entrX - 1, by + 1, entrZ, 'minecraft:bone_block');
      if (grid.inBounds(entrX + 1, by + 1, entrZ))
        grid.set(entrX + 1, by + 1, entrZ, 'minecraft:bone_block');
    }
  }

  // Staircase from surface to first underground level
  const topStairY = groundY - STORY_H;
  if (topStairY >= 0) {
    staircase(grid, xMid + 1, xMid + 2, bz1 + 3, topStairY, groundY, gh);
  }

  // ── Wall weathering: mix cracked/mossy variants for texture variety ──
  const wallVariants = [
    'minecraft:mossy_stone_bricks', 'minecraft:cracked_stone_bricks',
    'minecraft:cobblestone', 'minecraft:mossy_cobblestone',
  ];
  weatherWalls(grid, bx1, 0, bz1, bx2, groundY + entrH, bz2, style.wall, wallVariants, rng, 0.18);
  // Add extra cobwebs in room corners for atmosphere
  for (let level = 0; level < floors; level++) {
    const by = groundY - (level + 1) * STORY_H;
    if (by < 0) break;
    addCobwebs(grid, bx1 + 1, by + 1, bz1 + 1, bx2 - 1, by + STORY_H - 1, bz2 - 1, rng, 0.12);
    addChains(grid, bx1 + 2, by + STORY_H - 1, bz1 + 2, bx2 - 2, bz2 - 2, rng, 0.06);
  }

  // ── Edge-defining accent blocks — high-contrast pilasters on entrance corners ──
  const edgeBlock = style.wall === 'minecraft:deepslate_bricks'
    ? 'minecraft:polished_blackstone' : 'minecraft:polished_deepslate';
  for (let y = groundY + 1; y <= groundY + entrH; y++) {
    for (const [ecx, ecz] of [[ex1, ez1], [ex2, ez1], [ex1, ez2], [ex2, ez2]] as [number, number][]) {
      if (grid.inBounds(ecx, y, ecz))
        grid.set(ecx, y, ecz, edgeBlock);
    }
  }
  accentBand(grid, ex1, groundY + entrH, ez1, ex2, ez2, style.wallAccent);
  // Lanterns flanking entrance gate
  if (grid.inBounds(xMid - 3, groundY + 3, ez1 - 1))
    grid.set(xMid - 3, groundY + 3, ez1 - 1, style.lanternFloor);
  if (grid.inBounds(xMid + 3, groundY + 3, ez1 - 1))
    grid.set(xMid + 3, groundY + 3, ez1 - 1, style.lanternFloor);

  // ── Surface terrain mound — earth/stone cover over underground dungeon ──
  // Creates irregular hill silhouette instead of flat ground
  for (let x = bx1 + 2; x <= bx2 - 2; x++) {
    for (let z = ez2 + 2; z <= bz2 - 2; z++) {
      // Distance from center determines mound height (paraboloid falloff)
      const dx = (x - xMid) / (bw / 2);
      const dz = (z - zMid) / (bl / 2);
      const dist = Math.sqrt(dx * dx + dz * dz);
      const moundH = Math.max(0, Math.round(3 * (1 - dist * dist)));
      for (let y = groundY + 1; y <= groundY + moundH; y++) {
        if (grid.inBounds(x, y, z)) {
          // Outer layer = grass/dirt, inner = stone
          const block = y === groundY + moundH
            ? 'minecraft:moss_block'
            : (rng() < 0.3 ? 'minecraft:coarse_dirt' : style.foundation);
          grid.set(x, y, z, block);
        }
      }
    }
  }

  // ── Ruined flanking walls — collapsed stone extending from entrance ──
  // Left flank wall (decaying, varying height)
  for (let z = ez1; z <= ez1 + 6; z++) {
    const wallHeight = Math.max(1, 4 - Math.floor(rng() * 3));
    for (let y = groundY + 1; y <= groundY + wallHeight; y++) {
      if (grid.inBounds(ex1 - 2, y, z))
        grid.set(ex1 - 2, y, z, rng() < 0.4 ? 'minecraft:mossy_cobblestone' : style.wall);
    }
  }
  // Right flank wall
  for (let z = ez1; z <= ez1 + 5; z++) {
    const wallHeight = Math.max(1, 3 - Math.floor(rng() * 2));
    for (let y = groundY + 1; y <= groundY + wallHeight; y++) {
      if (grid.inBounds(ex2 + 2, y, z))
        grid.set(ex2 + 2, y, z, rng() < 0.4 ? 'minecraft:mossy_cobblestone' : style.wall);
    }
  }

  // ── Rubble scatter around entrance — broken stone debris ──
  const rubbleBlocks = ['minecraft:cobblestone', 'minecraft:gravel', 'minecraft:mossy_cobblestone'];
  for (let x = ex1 - 3; x <= ex2 + 3; x++) {
    for (let z = ez1 - 3; z <= ez1 - 1; z++) {
      if (grid.inBounds(x, groundY, z) && rng() < 0.35) {
        grid.set(x, groundY, z, pick(rubbleBlocks, rng));
        // Occasional tall rubble piece
        if (rng() < 0.2 && grid.inBounds(x, groundY + 1, z))
          grid.set(x, groundY + 1, z, pick(rubbleBlocks, rng));
      }
    }
  }

  // ── Exposed shaft grate — visible from surface, hints at depth below ──
  const grateX = xMid + 6;
  const grateZ = zMid + 3;
  for (let dx = 0; dx <= 2; dx++) {
    for (let dz = 0; dz <= 2; dz++) {
      if (grid.inBounds(grateX + dx, groundY, grateZ + dz))
        grid.set(grateX + dx, groundY, grateZ + dz, 'minecraft:iron_bars');
    }
  }

  // ── Dead trees flanking entrance path — ominous atmosphere ──
  for (const [tx, tz] of [[ex1 - 4, ez1 + 2], [ex2 + 4, ez1 + 3]] as [number, number][]) {
    for (let ty = groundY + 1; ty <= groundY + 5; ty++) {
      if (grid.inBounds(tx, ty, tz))
        grid.set(tx, ty, tz, 'minecraft:spruce_log');
    }
    // Sparse bare branches
    if (grid.inBounds(tx + 1, groundY + 4, tz))
      grid.set(tx + 1, groundY + 4, tz, 'minecraft:spruce_log[axis=x]');
    if (grid.inBounds(tx - 1, groundY + 5, tz))
      grid.set(tx - 1, groundY + 5, tz, 'minecraft:spruce_log[axis=x]');
  }

  // ── Ruined watchtower — compositional secondary structure on surface ──
  const wtX = bx2 - 3;
  const wtZ = bz2 - 3;
  const wtR = 2;
  const wtH = 6; // Partially collapsed
  for (let y = groundY + 1; y <= groundY + wtH; y++) {
    // Irregular height — some blocks missing on upper levels
    const collapseChance = (y - groundY) / wtH;
    for (let dx = -wtR; dx <= wtR; dx++) {
      for (let dz = -wtR; dz <= wtR; dz++) {
        if (Math.sqrt(dx * dx + dz * dz) <= wtR + 0.5 && Math.sqrt(dx * dx + dz * dz) >= wtR - 0.5) {
          if (grid.inBounds(wtX + dx, y, wtZ + dz) && rng() > collapseChance * 0.4) {
            grid.set(wtX + dx, y, wtZ + dz,
              rng() < 0.3 ? 'minecraft:mossy_cobblestone' : style.wall);
          }
        }
      }
    }
  }
  // Stone path from entrance to watchtower
  for (let z = ez2 + 1; z <= wtZ; z++) {
    if (grid.inBounds(wtX, groundY, z))
      grid.set(wtX, groundY, z, 'minecraft:cobblestone');
  }
  // Perimeter fence (partial, decayed — wooden posts with gaps)
  for (let x = bx1; x <= bx2; x += 3) {
    if (grid.inBounds(x, groundY + 1, bz2) && rng() < 0.7)
      grid.set(x, groundY + 1, bz2, style.fence);
  }
  for (let z = bz1; z <= bz2; z += 3) {
    if (grid.inBounds(bx2, groundY + 1, z) && rng() < 0.7)
      grid.set(bx2, groundY + 1, z, style.fence);
  }

  return grid;
}

// ─── Ship ───────────────────────────────────────────────────────────────────

function generateShip(
  floors: number, style: StylePalette, rooms: RoomType[] | undefined,
  _bwOpt: number | undefined, blOpt: number | undefined, rng: () => number
): BlockGrid {
  const shipLen = blOpt ?? 35;
  const shipW = 11;
  const margin = 5;
  const gw = shipW + margin * 2;
  const gl = shipLen + margin * 2;
  const gh = floors * STORY_H + 35;

  const cx = margin + Math.floor(shipW / 2); // center X
  const sz1 = margin; // ship start Z (stern)
  const sz2 = margin + shipLen - 1; // ship end Z (bow)

  const grid = new BlockGrid(gw, gh, gl);

  // Hull shape: deeper V-hull with smooth bow/stern curvature
  const hullDepth = 5; // deeper hull for realistic ship profile
  const hullBase = hullDepth; // Y level of deck
  for (let z = sz1; z <= sz2; z++) {
    const zFrac = (z - sz1) / (sz2 - sz1); // 0=stern, 1=bow
    let halfWidth: number;
    if (zFrac < 0.18) {
      // Stern taper — smooth cosine curve for rounded transom
      const t = zFrac / 0.18;
      halfWidth = Math.round((0.5 - 0.5 * Math.cos(Math.PI * t)) * (shipW / 2));
    } else if (zFrac > 0.82) {
      // Bow taper — sharper cosine curve for pointed prow
      const t = (1 - zFrac) / 0.18;
      halfWidth = Math.round((0.5 - 0.5 * Math.cos(Math.PI * t)) * (shipW / 2));
    } else {
      halfWidth = Math.floor(shipW / 2);
    }
    halfWidth = Math.max(1, halfWidth);

    // Hull layers from keel to deck with pronounced V-shape
    for (let y = 0; y <= hullBase; y++) {
      // Keel narrows to ~25% of deck width using smoothstep for round hull curvature
      const depthFrac = y / hullBase; // 0=keel, 1=deck
      const curveFrac = depthFrac * depthFrac * (3 - 2 * depthFrac);
      const layerHalf = Math.max(1, Math.round(halfWidth * (0.25 + 0.75 * curveFrac)));

      for (let dx = -layerHalf; dx <= layerHalf; dx++) {
        const x = cx + dx;
        if (!grid.inBounds(x, y, z)) continue;

        if (Math.abs(dx) >= layerHalf - 1) {
          // Hull shell (outer planking)
          grid.set(x, y, z, style.wall);
        } else if (y === 0) {
          // Keel bottom
          grid.set(x, y, z, style.foundation);
        } else if (y < hullBase) {
          // Below-deck hull interior (solid for structure)
          grid.set(x, y, z, style.wall);
        }
      }
    }

    // Deck surface
    for (let dx = -halfWidth + 1; dx < halfWidth; dx++) {
      const x = cx + dx;
      if (grid.inBounds(x, hullBase, z)) {
        grid.set(x, hullBase, z, style.floorGround);
      }
    }
    // Deck edge planks
    if (halfWidth >= 1) {
      if (grid.inBounds(cx - halfWidth, hullBase, z)) {
        grid.set(cx - halfWidth, hullBase, z, style.wall);
      }
      if (grid.inBounds(cx + halfWidth, hullBase, z)) {
        grid.set(cx + halfWidth, hullBase, z, style.wall);
      }
    }

    // Deck railings
    if (halfWidth >= 2) {
      const leftRail = cx - halfWidth;
      const rightRail = cx + halfWidth;
      if (grid.inBounds(leftRail, hullBase + 1, z)) {
        grid.set(leftRail, hullBase + 1, z, style.fence);
      }
      if (grid.inBounds(rightRail, hullBase + 1, z)) {
        grid.set(rightRail, hullBase + 1, z, style.fence);
      }
    }
  }

  // Clear hull interior space for cabins
  for (let y = 1; y < hullBase; y++) {
    const midZStart = sz1 + Math.floor(shipLen * 0.18);
    const midZEnd = sz1 + Math.floor(shipLen * 0.82);
    for (let z = midZStart; z <= midZEnd; z++) {
      for (let dx = -(Math.floor(shipW / 2) - 2); dx <= Math.floor(shipW / 2) - 2; dx++) {
        const x = cx + dx;
        if (grid.inBounds(x, y, z)) {
          grid.set(x, y, z, 'minecraft:air');
        }
      }
    }
  }

  // ── Cargo hold details (below deck, between rooms) ──
  const holdY = 1; // just above keel
  const holdZ1 = sz1 + Math.floor(shipLen * 0.20);
  const holdZ2 = sz1 + Math.floor(shipLen * 0.80);
  const holdHalf = Math.floor(shipW / 2) - 3;
  // Barrel clusters along port/starboard walls
  for (let z = holdZ1 + 2; z < holdZ2 - 2; z += 5) {
    for (const side of [-1, 1]) {
      const bx = cx + side * holdHalf;
      if (grid.inBounds(bx, holdY, z))
        grid.set(bx, holdY, z, 'minecraft:barrel[facing=up]');
      if (grid.inBounds(bx, holdY + 1, z))
        grid.set(bx, holdY + 1, z, 'minecraft:barrel[facing=up]');
      if (grid.inBounds(bx, holdY, z + 1))
        grid.set(bx, holdY, z + 1, 'minecraft:barrel[facing=up]');
    }
  }
  // Chests in hold center
  for (let z = holdZ1 + 4; z < holdZ2 - 4; z += 8) {
    if (grid.inBounds(cx, holdY, z))
      grid.set(cx, holdY, z, 'minecraft:chest[facing=south]');
    if (grid.inBounds(cx + 1, holdY, z))
      grid.set(cx + 1, holdY, z, 'minecraft:hay_block');
  }
  // Hanging lanterns in hold
  for (let z = holdZ1 + 3; z < holdZ2 - 2; z += 6) {
    if (grid.inBounds(cx, hullBase - 1, z))
      grid.set(cx, hullBase - 1, z, style.lantern);
  }
  // Hay bale cargo stacks
  for (let z = holdZ2 - 6; z <= holdZ2 - 3; z++) {
    for (const side of [-1, 1]) {
      const hx = cx + side * (holdHalf - 1);
      if (grid.inBounds(hx, holdY, z))
        grid.set(hx, holdY, z, 'minecraft:hay_block');
      if (grid.inBounds(hx, holdY + 1, z))
        grid.set(hx, holdY + 1, z, 'minecraft:hay_block');
    }
  }

  // Below-deck cabins
  for (let story = 0; story < Math.min(floors, 2); story++) {
    const cabinY = hullBase + 1 + story * STORY_H;
    const cabinZ1 = sz1 + Math.floor(shipLen * 0.2);
    const cabinZ2 = sz1 + Math.floor(shipLen * 0.65);
    const cabinX1 = cx - Math.floor(shipW / 2) + 1;
    const cabinX2 = cx + Math.floor(shipW / 2) - 1;

    // Cabin walls and floor
    grid.fill(cabinX1, cabinY - 1, cabinZ1, cabinX2, cabinY - 1, cabinZ2, style.floorUpper);
    exteriorWalls(grid, cabinX1, cabinY, cabinZ1, cabinX2, cabinY + STORY_H - 2, cabinZ2, style);
    grid.fill(cabinX1, cabinY + STORY_H - 1, cabinZ1, cabinX2, cabinY + STORY_H - 1, cabinZ2, style.ceiling);

    // Windows
    windows(grid, cabinX1, cabinZ1, cabinX2, cabinZ2, cabinY + 1, cabinY + 2, style, 4);

    // Door
    const doorZ = cabinZ1;
    grid.set(cx, cabinY, doorZ, style.doorLowerS);
    grid.set(cx, cabinY + 1, doorZ, style.doorUpperS);

    // Interior rooms
    const cxMid = Math.floor((cabinX1 + cabinX2) / 2);
    interiorWall(grid, 'z', cxMid, cabinZ1 + 1, cabinZ2 - 1, cabinY, cabinY + STORY_H - 2, style);
    doorway(grid, cxMid, cabinY, Math.floor((cabinZ1 + cabinZ2) / 2) - 1,
            cxMid, cabinY + 2, Math.floor((cabinZ1 + cabinZ2) / 2) + 1);

    const shipRooms: RoomType[] = ['bedroom', 'kitchen', 'dining', 'vault', 'armory', 'study'];
    const leftRoom = rooms?.[story * 2] ?? pick(shipRooms, rng);
    const rightRoom = rooms?.[story * 2 + 1] ?? pick(shipRooms, rng);

    getRoomGenerator(leftRoom)(grid, {
      x1: cabinX1 + 1, y: cabinY, z1: cabinZ1 + 1,
      x2: cxMid - 1, z2: cabinZ2 - 1, height: STORY_H - 1,
    }, style);
    getRoomGenerator(rightRoom)(grid, {
      x1: cxMid + 1, y: cabinY, z1: cabinZ1 + 1,
      x2: cabinX2 - 1, z2: cabinZ2 - 1, height: STORY_H - 1,
    }, style);
  }

  // ── Compute sail clearance — sails must start above highest cabin ──
  const cabinStories = Math.min(floors, 2);
  const cabinTopY = hullBase + 1 + cabinStories * STORY_H - 1;
  const sternTopY = hullBase + 1 + 4; // stern cabin ceiling
  const sailStartY = Math.max(cabinTopY, sternTopY) + 1;
  // Minimum sail height = cabin height (ensures visually proportional sails)
  const minSailH = cabinStories * STORY_H;

  // ── Main mast (midship, tallest) ──
  const mastZ = sz1 + Math.floor(shipLen * 0.45);
  // Mast must be tall enough for two sail tiers each at least minSailH, but capped to grid height
  const mastH = Math.min(
    Math.max(20, sailStartY - hullBase + minSailH * 2 + 8),
    gh - hullBase - 1,
  );
  const yardHalf = Math.floor(shipW / 2) + 1;
  for (let y = hullBase; y < hullBase + mastH; y++) {
    if (grid.inBounds(cx, y, mastZ)) grid.set(cx, y, mastZ, style.timber);
  }

  // Crow's nest at top of main mast
  const nestY = hullBase + mastH - 2;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (grid.inBounds(cx + dx, nestY, mastZ + dz))
        grid.set(cx + dx, nestY, mastZ + dz, style.floorUpper);
    }
  }
  for (let dx = -1; dx <= 1; dx++) {
    if (grid.inBounds(cx + dx, nestY + 1, mastZ - 1))
      grid.set(cx + dx, nestY + 1, mastZ - 1, style.fence);
    if (grid.inBounds(cx + dx, nestY + 1, mastZ + 1))
      grid.set(cx + dx, nestY + 1, mastZ + 1, style.fence);
  }
  if (grid.inBounds(cx - 1, nestY + 1, mastZ))
    grid.set(cx - 1, nestY + 1, mastZ, style.fence);
  if (grid.inBounds(cx + 1, nestY + 1, mastZ))
    grid.set(cx + 1, nestY + 1, mastZ, style.fence);
  // Restore mast through crow's nest
  if (grid.inBounds(cx, nestY, mastZ)) grid.set(cx, nestY, mastZ, style.timber);
  if (grid.inBounds(cx, nestY + 1, mastZ)) grid.set(cx, nestY + 1, mastZ, style.timber);

  // Yard positions: ensure each sail tier is at least minSailH tall
  const lowerYardY = Math.max(hullBase + Math.floor(mastH * 0.4), sailStartY + minSailH);
  const yardY = Math.max(hullBase + Math.floor(mastH * 0.8), lowerYardY + Math.floor(minSailH * 0.7));

  // Upper yard arm
  for (let dx = -yardHalf; dx <= yardHalf; dx++) {
    if (grid.inBounds(cx + dx, yardY, mastZ))
      grid.set(cx + dx, yardY, mastZ, style.timberX);
  }

  // Lower yard arm
  for (let dx = -yardHalf; dx <= yardHalf; dx++) {
    if (grid.inBounds(cx + dx, lowerYardY, mastZ))
      grid.set(cx + dx, lowerYardY, mastZ, style.timberX);
  }

  // Upper main sail (between upper and lower yard arms, 1 block deep)
  for (let y = lowerYardY + 1; y < yardY; y++) {
    const frac = (y - lowerYardY - 1) / Math.max(1, yardY - lowerYardY - 2);
    const rowHalf = Math.max(1, Math.round(yardHalf * (0.8 + 0.2 * frac)));
    for (let dx = -rowHalf; dx <= rowHalf; dx++) {
      if (grid.inBounds(cx + dx, y, mastZ))
        grid.set(cx + dx, y, mastZ, 'minecraft:white_wool');
    }
  }

  // Lower main sail (lower yard to above cabins, 1 block deep)
  for (let y = sailStartY; y < lowerYardY; y++) {
    const frac = (y - sailStartY) / Math.max(1, lowerYardY - sailStartY - 1);
    const rowHalf = Math.max(1, Math.round(yardHalf * (0.8 + 0.2 * frac)));
    for (let dx = -rowHalf; dx <= rowHalf; dx++) {
      if (grid.inBounds(cx + dx, y, mastZ))
        grid.set(cx + dx, y, mastZ, 'minecraft:white_wool');
    }
  }

  // Restore mast through sails
  for (let y = sailStartY; y < yardY; y++) {
    if (grid.inBounds(cx, y, mastZ)) grid.set(cx, y, mastZ, style.timber);
  }

  // ── Foremast (near bow, shorter) ──
  const foremastZ = sz1 + Math.floor(shipLen * 0.7);
  const foremastH = Math.max(16, sailStartY - hullBase + minSailH + 6);
  for (let y = hullBase; y < hullBase + foremastH; y++) {
    if (grid.inBounds(cx, y, foremastZ)) grid.set(cx, y, foremastZ, style.timber);
  }
  // Yard must be at least minSailH above sailStartY
  const foreYardY = Math.max(hullBase + Math.floor(foremastH * 0.75), sailStartY + minSailH);
  const foreYardHalf = yardHalf - 1;
  for (let dx = -foreYardHalf; dx <= foreYardHalf; dx++) {
    if (grid.inBounds(cx + dx, foreYardY, foremastZ))
      grid.set(cx + dx, foreYardY, foremastZ, style.timberX);
  }
  // Fore sail (1 block deep, starts above cabins)
  for (let y = sailStartY; y < foreYardY; y++) {
    const frac = (y - sailStartY) / Math.max(1, foreYardY - sailStartY - 1);
    const rowHalf = Math.max(1, Math.round(foreYardHalf * (0.8 + 0.2 * frac)));
    for (let dx = -rowHalf; dx <= rowHalf; dx++) {
      if (grid.inBounds(cx + dx, y, foremastZ))
        grid.set(cx + dx, y, foremastZ, 'minecraft:white_wool');
    }
  }
  for (let y = sailStartY; y < foreYardY; y++) {
    if (grid.inBounds(cx, y, foremastZ)) grid.set(cx, y, foremastZ, style.timber);
  }

  // ── Mizzen mast (near stern, shortest) ──
  const mizzenZ = sz1 + Math.floor(shipLen * 0.18);
  const mizzenH = Math.max(13, sailStartY - hullBase + minSailH + 4);
  for (let y = hullBase; y < hullBase + mizzenH; y++) {
    if (grid.inBounds(cx, y, mizzenZ)) grid.set(cx, y, mizzenZ, style.timber);
  }
  // Yard must be at least minSailH above sailStartY
  const mizYardY = Math.max(hullBase + Math.floor(mizzenH * 0.75), sailStartY + minSailH);
  const mizYardHalf = yardHalf - 2;
  for (let dx = -mizYardHalf; dx <= mizYardHalf; dx++) {
    if (grid.inBounds(cx + dx, mizYardY, mizzenZ))
      grid.set(cx + dx, mizYardY, mizzenZ, style.timberX);
  }
  // Mizzen sail (1 block deep, starts above cabins)
  const mizSailStart = Math.max(sailStartY, sternTopY + 1);
  for (let y = mizSailStart; y < mizYardY; y++) {
    const frac = (y - mizSailStart) / Math.max(1, mizYardY - mizSailStart - 1);
    const rowHalf = Math.max(1, Math.round(mizYardHalf * (0.8 + 0.2 * frac)));
    for (let dx = -rowHalf; dx <= rowHalf; dx++) {
      if (grid.inBounds(cx + dx, y, mizzenZ))
        grid.set(cx + dx, y, mizzenZ, 'minecraft:white_wool');
    }
  }
  for (let y = mizSailStart; y < mizYardY; y++) {
    if (grid.inBounds(cx, y, mizzenZ)) grid.set(cx, y, mizzenZ, style.timber);
  }

  // Bowsprit (extended, angled down toward water)
  const bowZ = sz2 + 1;
  for (let dz = 0; dz < 7; dz++) {
    const by = hullBase + 2 - Math.floor(dz / 3);
    if (grid.inBounds(cx, by, bowZ + dz))
      grid.set(cx, by, bowZ + dz, style.timberZ);
  }

  // Stern cabin (captain's quarters)
  const sternZ1 = sz1 + 1;
  const sternZ2 = sz1 + Math.floor(shipLen * 0.15);
  const sternX1 = cx - 3;
  const sternX2 = cx + 3;
  const sternY = hullBase + 1;
  exteriorWalls(grid, sternX1, sternY, sternZ1, sternX2, sternY + 3, sternZ2, style);
  grid.fill(sternX1, sternY + 4, sternZ1, sternX2, sternY + 4, sternZ2, style.ceiling);
  windows(grid, sternX1, sternZ1, sternX2, sternZ2, sternY + 1, sternY + 2, style, 3);

  // Captain's quarters interior
  getRoomGenerator('study')(grid, {
    x1: sternX1 + 1, y: sternY, z1: sternZ1 + 1,
    x2: sternX2 - 1, z2: sternZ2 - 1, height: 3,
  }, style);

  // ── Deck details ──
  // Ship wheel (between stern cabin and midship)
  const wheelZ = sternZ2 + 2;
  if (grid.inBounds(cx, hullBase + 1, wheelZ)) {
    grid.set(cx, hullBase + 1, wheelZ, style.fence);
    grid.set(cx, hullBase + 2, wheelZ, 'minecraft:dark_oak_trapdoor[facing=south,half=top,open=true]');
  }

  // Deck barrels and crates (scattered around masts)
  const deckY = hullBase + 1;
  const halfDeck = Math.floor(shipW / 2) - 2;
  // Port side barrels near main mast
  if (grid.inBounds(cx - halfDeck, deckY, mastZ + 3))
    grid.set(cx - halfDeck, deckY, mastZ + 3, 'minecraft:barrel[facing=up]');
  if (grid.inBounds(cx - halfDeck, deckY, mastZ + 4))
    grid.set(cx - halfDeck, deckY, mastZ + 4, 'minecraft:barrel[facing=up]');
  if (grid.inBounds(cx - halfDeck, deckY + 1, mastZ + 3))
    grid.set(cx - halfDeck, deckY + 1, mastZ + 3, 'minecraft:barrel[facing=up]');
  // Starboard side crates near foremast
  if (grid.inBounds(cx + halfDeck, deckY, foremastZ - 2))
    grid.set(cx + halfDeck, deckY, foremastZ - 2, 'minecraft:barrel[facing=up]');
  if (grid.inBounds(cx + halfDeck, deckY, foremastZ - 3))
    grid.set(cx + halfDeck, deckY, foremastZ - 3, 'minecraft:barrel[facing=up]');
  // Rope coils (brown wool)
  if (grid.inBounds(cx + 2, deckY, mastZ + 2))
    grid.set(cx + 2, deckY, mastZ + 2, 'minecraft:brown_wool');
  if (grid.inBounds(cx - 2, deckY, foremastZ - 1))
    grid.set(cx - 2, deckY, foremastZ - 1, 'minecraft:brown_wool');

  // Stern lanterns
  if (grid.inBounds(cx - 2, hullBase + 2, sz1))
    grid.set(cx - 2, hullBase + 2, sz1, style.lanternFloor);
  if (grid.inBounds(cx + 2, hullBase + 2, sz1))
    grid.set(cx + 2, hullBase + 2, sz1, style.lanternFloor);

  // Deck lanterns along railings (every 6 blocks)
  for (let z = sz1 + 4; z < sz2 - 4; z += 6) {
    for (const side of [-1, 1]) {
      const lx = cx + side * (Math.floor(shipW / 2) - 1);
      if (grid.inBounds(lx, deckY + 1, z))
        grid.set(lx, deckY + 1, z, style.lanternFloor);
    }
  }
  // Cargo hatch (trapdoor) on deck between masts
  const hatchZ = Math.floor((mastZ + foremastZ) / 2);
  for (let dx = -1; dx <= 1; dx++) {
    if (grid.inBounds(cx + dx, hullBase, hatchZ))
      grid.set(cx + dx, hullBase, hatchZ, 'minecraft:dark_oak_trapdoor[facing=south,half=top,open=false]');
  }

  // Rigging — chains from mast tops down to deck edges
  const riggingPairs: [number, number, number][] = [
    [mastZ, hullBase + mastH - 3, halfDeck],
    [foremastZ, hullBase + foremastH - 3, halfDeck],
  ];
  for (const [rz, topY, rHalf] of riggingPairs) {
    for (const side of [-1, 1]) {
      const steps = topY - deckY;
      for (let i = 0; i < steps; i++) {
        const ry = topY - i;
        const rx = cx + side * Math.round(rHalf * (i / steps));
        if (grid.inBounds(rx, ry, rz) && grid.get(rx, ry, rz) === 'minecraft:air') {
          grid.set(rx, ry, rz, 'minecraft:chain');
        }
      }
    }
  }

  // Additional deck barrels near stern
  if (grid.inBounds(cx - 2, deckY, sternZ2 + 3))
    grid.set(cx - 2, deckY, sternZ2 + 3, 'minecraft:barrel[facing=up]');
  if (grid.inBounds(cx - 2, deckY, sternZ2 + 4))
    grid.set(cx - 2, deckY, sternZ2 + 4, 'minecraft:barrel[facing=up]');

  // Coiled rope (chains) near bow
  if (grid.inBounds(cx + 1, deckY, sz2 - 3))
    grid.set(cx + 1, deckY, sz2 - 3, 'minecraft:chain');
  if (grid.inBounds(cx - 1, deckY, sz2 - 2))
    grid.set(cx - 1, deckY, sz2 - 2, 'minecraft:chain');

  // ── Bow figurehead — multi-block prow decoration ──
  if (grid.inBounds(cx, hullBase + 1, sz2))
    grid.set(cx, hullBase + 1, sz2, 'minecraft:carved_pumpkin[facing=south]');
  // Gold accent trim along bowsprit
  if (grid.inBounds(cx, hullBase + 2, sz2))
    grid.set(cx, hullBase + 2, sz2, 'minecraft:gold_block');
  // Banners trailing from bowsprit
  if (grid.inBounds(cx - 1, hullBase + 2, sz2 + 1))
    grid.set(cx - 1, hullBase + 2, sz2 + 1, style.bannerN);

  // ── Stern gallery windows — adds detail to captain's quarters rear ──
  for (let dx = -2; dx <= 2; dx++) {
    if (grid.inBounds(cx + dx, hullBase + 2, sz1))
      grid.set(cx + dx, hullBase + 2, sz1, style.window);
    if (grid.inBounds(cx + dx, hullBase + 3, sz1))
      grid.set(cx + dx, hullBase + 3, sz1, style.window);
  }
  // Stern name plate (sign-like accent)
  if (grid.inBounds(cx, hullBase + 4, sz1))
    grid.set(cx, hullBase + 4, sz1, style.wallAccent);

  // ── Deck furnishing — ship's bell + compass table ──
  const bellZ = sternZ2 + 1;
  if (grid.inBounds(cx, deckY + 1, bellZ))
    grid.set(cx, deckY + 1, bellZ, 'minecraft:bell[attachment=floor]');
  // Navigation table near wheel
  if (grid.inBounds(cx + 2, deckY, wheelZ))
    grid.set(cx + 2, deckY, wheelZ, style.fence);
  if (grid.inBounds(cx + 2, deckY + 1, wheelZ))
    grid.set(cx + 2, deckY + 1, wheelZ, 'minecraft:cartography_table');

  // ── Hull reinforcement trim — darker accent stripe at waterline ──
  for (let z = sz1; z <= sz2; z++) {
    const zFrac = (z - sz1) / (sz2 - sz1);
    let halfWidth: number;
    if (zFrac < 0.18) {
      const t = zFrac / 0.18;
      halfWidth = Math.round((0.5 - 0.5 * Math.cos(Math.PI * t)) * (shipW / 2));
    } else if (zFrac > 0.82) {
      const t = (1 - zFrac) / 0.18;
      halfWidth = Math.round((0.5 - 0.5 * Math.cos(Math.PI * t)) * (shipW / 2));
    } else {
      halfWidth = Math.floor(shipW / 2);
    }
    halfWidth = Math.max(1, halfWidth);
    // Waterline accent at y=2 (hull stripe)
    for (const side of [-1, 1]) {
      const hx = cx + side * halfWidth;
      if (grid.inBounds(hx, 2, z))
        grid.set(hx, 2, z, style.wallAccent);
    }
  }

  // ── Cannon ports (dark openings) along midship hull ──
  const portZStart = sz1 + Math.floor(shipLen * 0.25);
  const portZEnd = sz1 + Math.floor(shipLen * 0.75);
  for (let z = portZStart; z <= portZEnd; z += 5) {
    for (const side of [-1, 1]) {
      const px = cx + side * Math.floor(shipW / 2);
      if (grid.inBounds(px, hullBase - 1, z))
        grid.set(px, hullBase - 1, z, 'minecraft:air'); // cannon port hole
    }
  }

  // ── Stern decoration — ornate name plate and railing ──
  for (let dx = -2; dx <= 2; dx++) {
    if (grid.inBounds(cx + dx, hullBase + 1, sz1))
      grid.set(cx + dx, hullBase + 1, sz1, style.fence); // stern railing
  }
  // Stern lantern cluster
  if (grid.inBounds(cx, hullBase + 3, sz1 - 1))
    grid.set(cx, hullBase + 3, sz1 - 1, style.lanternFloor);

  // ── Dock / pier structure alongside ship — compositional complexity ──
  const dockX1 = 0;
  const dockX2 = cx - Math.floor(shipW / 2) - 2;
  const dockZ1 = sz1 + Math.floor(shipLen * 0.2);
  const dockZ2 = sz1 + Math.floor(shipLen * 0.7);
  if (dockX2 > dockX1) {
    // Dock platform (raised above water)
    for (let x = dockX1; x <= dockX2; x++) {
      for (let z = dockZ1; z <= dockZ2; z++) {
        if (grid.inBounds(x, 2, z))
          grid.set(x, 2, z, style.floorGround);
      }
    }
    // Dock pilings (support posts going down into water)
    for (let x = dockX1 + 1; x <= dockX2; x += 3) {
      for (let z = dockZ1; z <= dockZ2; z += 4) {
        for (let y = 0; y <= 2; y++) {
          if (grid.inBounds(x, y, z))
            grid.set(x, y, z, style.timber);
        }
      }
    }
    // Dock railing on outer edge
    for (let z = dockZ1; z <= dockZ2; z++) {
      if (grid.inBounds(dockX1, 3, z))
        grid.set(dockX1, 3, z, style.fence);
    }
    // Cargo crates on dock
    const crateX = dockX1 + 2;
    for (let dz = 0; dz < 3; dz++) {
      const cz = dockZ1 + 2 + dz * 2;
      if (grid.inBounds(crateX, 3, cz)) {
        grid.set(crateX, 3, cz, 'minecraft:barrel[facing=up]');
        if (dz === 0 && grid.inBounds(crateX, 4, cz))
          grid.set(crateX, 4, cz, 'minecraft:barrel[facing=up]');
      }
    }
    // Dock lanterns
    if (grid.inBounds(dockX1 + 1, 3, dockZ1))
      grid.set(dockX1 + 1, 3, dockZ1, style.lanternFloor);
    if (grid.inBounds(dockX1 + 1, 3, dockZ2))
      grid.set(dockX1 + 1, 3, dockZ2, style.lanternFloor);
    // Gangplank connecting dock to ship
    const gpZ = Math.floor((dockZ1 + dockZ2) / 2);
    for (let x = dockX2 + 1; x <= cx - Math.floor(shipW / 2); x++) {
      if (grid.inBounds(x, 3, gpZ))
        grid.set(x, 3, gpZ, style.slabBottom);
    }
  }

  return grid;
}

// ─── Cathedral ───────────────────────────────────────────────────────────────

function generateCathedral(
  floors: number, style: StylePalette, _rooms: RoomType[] | undefined,
  bwOpt: number | undefined, blOpt: number | undefined, _rng: () => number
): BlockGrid {
  const bw = bwOpt ?? 45;
  const bl = blOpt ?? 60;
  const margin = 5;
  const gw = bw + margin * 2;
  const gl = bl + margin * 2;
  const mainH = Math.max(floors, 2) * STORY_H;
  const gh = mainH + ROOF_H + 15; // extra for bell tower

  const bx1 = margin;
  const bx2 = margin + bw - 1;
  const bz1 = margin;
  const bz2 = margin + bl - 1;
  const xMid = margin + Math.floor(bw / 2);
  const naveW = Math.floor(bw * 0.4); // central nave width
  const aisleW = Math.floor((bw - naveW) / 2); // side aisle width

  const grid = new BlockGrid(gw, gh, gl);

  // Foundation
  foundation(grid, bx1, bz1, bx2, bz2, style);

  // Main nave floor
  grid.fill(bx1 + 1, 0, bz1 + 1, bx2 - 1, 0, bz2 - 1, style.floorGround);

  // Exterior walls — full height of nave
  for (let y = 1; y <= mainH; y++) {
    for (let x = bx1; x <= bx2; x++) {
      grid.set(x, y, bz1, style.wall);
      grid.set(x, y, bz2, style.wall);
    }
    for (let z = bz1; z <= bz2; z++) {
      grid.set(bx1, y, z, style.wall);
      grid.set(bx2, y, z, style.wall);
    }
  }

  // Nave ceiling (higher than aisles)
  const naveX1 = bx1 + aisleW;
  const naveX2 = bx2 - aisleW;
  grid.fill(naveX1, mainH, bz1, naveX2, mainH, bz2, style.ceiling);

  // Side aisle ceilings (lower)
  const aisleH = Math.floor(mainH * 0.6);
  grid.fill(bx1 + 1, aisleH, bz1 + 1, naveX1 - 1, aisleH, bz2 - 1, style.ceiling);
  grid.fill(naveX2 + 1, aisleH, bz1 + 1, bx2 - 1, aisleH, bz2 - 1, style.ceiling);

  // Pillar rows separating nave from side aisles
  for (let z = bz1 + 4; z < bz2 - 3; z += 4) {
    for (let y = 1; y <= mainH; y++) {
      grid.set(naveX1, y, z, style.pillar);
      grid.set(naveX2, y, z, style.pillar);
    }
  }

  // Stained glass windows — tall paired windows along sides
  for (let z = bz1 + 3; z < bz2 - 2; z += 4) {
    for (let y = 3; y <= mainH - 2; y++) {
      // High clerestory windows above aisle roof
      if (y > aisleH) {
        grid.set(naveX1 - 1, y, z, style.windowAccent);
        grid.set(naveX2 + 1, y, z, style.windowAccent);
      }
      // Aisle windows
      if (y <= aisleH - 1) {
        grid.set(bx1, y, z, style.windowAccent);
        grid.set(bx2, y, z, style.windowAccent);
      }
    }
  }

  // Rose window on front (Z = bz1) — circular stained glass pattern
  const roseY = Math.floor(mainH * 0.65);
  const roseR = 3;
  for (let dx = -roseR; dx <= roseR; dx++) {
    for (let dy = -roseR; dy <= roseR; dy++) {
      if (Math.sqrt(dx * dx + dy * dy) <= roseR + 0.5) {
        const rx = xMid + dx;
        const ry = roseY + dy;
        if (grid.inBounds(rx, ry, bz1)) {
          // Alternate colors in concentric rings
          const dist = Math.sqrt(dx * dx + dy * dy);
          const glassColor = dist <= 1.5 ? 'minecraft:yellow_stained_glass_pane'
            : dist <= 2.5 ? 'minecraft:red_stained_glass'
            : 'minecraft:blue_stained_glass_pane';
          grid.set(rx, ry, bz1, glassColor);
        }
      }
    }
  }

  // Front entrance — arched doorway
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = 1; dy <= 5; dy++) {
      if (grid.inBounds(xMid + dx, dy, bz1))
        grid.set(xMid + dx, dy, bz1, 'minecraft:air');
    }
  }
  // Arch top
  grid.set(xMid - 2, 5, bz1, style.wallAccent);
  grid.set(xMid + 2, 5, bz1, style.wallAccent);
  grid.set(xMid - 1, 6, bz1, style.wallAccent);
  grid.set(xMid + 1, 6, bz1, style.wallAccent);
  grid.set(xMid, 6, bz1, style.wallAccent);
  // Doors
  grid.set(xMid - 1, 1, bz1, style.doorLowerS);
  grid.set(xMid - 1, 2, bz1, style.doorUpperS);
  grid.set(xMid, 1, bz1, style.doorLowerS);
  grid.set(xMid, 2, bz1, style.doorUpperS);

  // Apse (semicircular altar end at high-Z)
  const apseR = Math.floor(naveW / 2) - 1;
  const apseCZ = bz2;
  for (let dx = -apseR; dx <= apseR; dx++) {
    for (let dz = 0; dz <= apseR; dz++) {
      if (Math.sqrt(dx * dx + dz * dz) <= apseR + 0.5) {
        const ax = xMid + dx;
        const az = apseCZ + dz;
        if (grid.inBounds(ax, 0, az)) {
          grid.set(ax, 0, az, style.floorGround);
          // Apse walls (outer ring)
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist >= apseR - 0.5) {
            for (let y = 1; y <= mainH; y++) {
              grid.set(ax, y, az, style.wall);
            }
          }
        }
      }
    }
  }

  // Flying buttresses (exterior supports along sides)
  for (let z = bz1 + 6; z < bz2 - 4; z += 8) {
    for (const side of [bx1, bx2]) {
      const dir = side === bx1 ? -1 : 1;
      // Buttress pillar extending outward
      for (let y = 1; y <= aisleH + 2; y++) {
        const bx = side + dir * 2;
        if (grid.inBounds(bx, y, z)) grid.set(bx, y, z, style.wall);
      }
      // Arch from pillar to wall
      for (let i = 0; i <= 2; i++) {
        const bx = side + dir * (2 - i);
        const by = aisleH + i;
        if (grid.inBounds(bx, by, z)) grid.set(bx, by, z, style.wall);
      }
    }
  }

  // Interior: pew rows (stairs facing altar)
  const pewZ1 = bz1 + 8;
  const pewZ2 = bz2 - 10;
  for (let z = pewZ1; z <= pewZ2; z += 2) {
    // Left pew block
    for (let x = naveX1 + 2; x <= xMid - 2; x++) {
      grid.set(x, 1, z, style.chairN);
    }
    // Right pew block
    for (let x = xMid + 2; x <= naveX2 - 2; x++) {
      grid.set(x, 1, z, style.chairN);
    }
  }

  // Central aisle carpet
  for (let z = bz1 + 1; z <= bz2 - 1; z++) {
    grid.set(xMid - 1, 0, z, style.carpet);
    grid.set(xMid, 0, z, style.carpet);
    grid.set(xMid + 1, 0, z, style.carpet);
  }

  // Altar platform
  grid.fill(xMid - 3, 0, bz2 - 5, xMid + 3, 0, bz2 - 3, style.wallAccent);
  grid.fill(xMid - 2, 1, bz2 - 5, xMid + 2, 1, bz2 - 3, style.wallAccent);
  grid.set(xMid, 2, bz2 - 4, 'minecraft:enchanting_table');

  // Candle arrays flanking altar (double row for grandeur)
  for (const dx of [-3, -2, 2, 3]) {
    grid.set(xMid + dx, 1, bz2 - 4, 'minecraft:candle[candles=4,lit=true]');
  }
  // Additional candle pairs on the altar steps
  grid.set(xMid - 2, 2, bz2 - 5, 'minecraft:candle[candles=4,lit=true]');
  grid.set(xMid + 2, 2, bz2 - 5, 'minecraft:candle[candles=4,lit=true]');

  // Banners along nave pillars
  for (let z = bz1 + 6; z < bz2 - 4; z += 8) {
    grid.set(naveX1 + 1, 4, z, style.bannerS);
    grid.set(naveX2 - 1, 4, z, style.bannerN);
  }

  // Bell tower (reusing circular tower logic, at front-left corner) — TALL steeple
  const towerR = 4;
  const towerCX = bx1 - 1;
  const towerCZ = bz1 - 1;
  const towerH = mainH + 18; // Extra tall for dramatic skyline
  for (let y = 0; y <= towerH; y++) {
    for (let dx = -towerR; dx <= towerR; dx++) {
      for (let dz = -towerR; dz <= towerR; dz++) {
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist <= towerR + 0.5) {
          const tx = towerCX + dx;
          const tz = towerCZ + dz;
          if (!grid.inBounds(tx, y, tz)) continue;
          if (y === 0) {
            grid.set(tx, y, tz, style.foundation);
          } else if (dist >= towerR - 0.5) {
            grid.set(tx, y, tz, style.wall);
          }
        }
      }
    }
  }
  // Tower cone
  for (let layer = 0; layer <= towerR + 1; layer++) {
    const ry = towerH + 1 + layer;
    const rr = towerR - layer;
    if (rr <= 0 || !grid.inBounds(0, ry, 0)) break;
    for (let dx = -rr; dx <= rr; dx++) {
      for (let dz = -rr; dz <= rr; dz++) {
        if (Math.sqrt(dx * dx + dz * dz) <= rr + 0.5) {
          const tx = towerCX + dx;
          const tz = towerCZ + dz;
          if (grid.inBounds(tx, ry, tz)) grid.set(tx, ry, tz, style.roofS);
        }
      }
    }
  }
  // Bell at top of tower
  grid.set(towerCX, towerH - 2, towerCZ, 'minecraft:bell[attachment=ceiling,facing=north]');
  // Cross atop bell tower spire
  const crossY = towerH + towerR + 3;
  if (grid.inBounds(towerCX, crossY, towerCZ))
    grid.set(towerCX, crossY, towerCZ, 'minecraft:end_rod[facing=up]');
  if (grid.inBounds(towerCX, crossY + 1, towerCZ))
    grid.set(towerCX, crossY + 1, towerCZ, 'minecraft:end_rod[facing=up]');
  if (grid.inBounds(towerCX - 1, crossY + 1, towerCZ))
    grid.set(towerCX - 1, crossY + 1, towerCZ, 'minecraft:end_rod[facing=up]');
  if (grid.inBounds(towerCX + 1, crossY + 1, towerCZ))
    grid.set(towerCX + 1, crossY + 1, towerCZ, 'minecraft:end_rod[facing=up]');

  // Second smaller tower at front-right for asymmetric facade
  const tower2CX = bx2 + 1;
  const tower2CZ = bz1 - 1;
  const tower2H = mainH + 8; // Shorter than main bell tower
  const tower2R = 3;
  for (let y = 0; y <= tower2H; y++) {
    for (let dx = -tower2R; dx <= tower2R; dx++) {
      for (let dz = -tower2R; dz <= tower2R; dz++) {
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist <= tower2R + 0.5) {
          const tx = tower2CX + dx;
          const tz = tower2CZ + dz;
          if (!grid.inBounds(tx, y, tz)) continue;
          if (y === 0) grid.set(tx, y, tz, style.foundation);
          else if (dist >= tower2R - 0.5) grid.set(tx, y, tz, style.wall);
        }
      }
    }
  }
  // Smaller tower cone
  for (let layer = 0; layer <= tower2R + 1; layer++) {
    const ry = tower2H + 1 + layer;
    const rr = tower2R - layer;
    if (rr <= 0 || !grid.inBounds(0, ry, 0)) break;
    for (let dx = -rr; dx <= rr; dx++) {
      for (let dz = -rr; dz <= rr; dz++) {
        if (Math.sqrt(dx * dx + dz * dz) <= rr + 0.5) {
          if (grid.inBounds(tower2CX + dx, ry, tower2CZ + dz))
            grid.set(tower2CX + dx, ry, tower2CZ + dz, style.roofS);
        }
      }
    }
  }

  // Nave roof (gabled)
  gabledRoof(grid, naveX1, bz1, naveX2, bz2 - 5, mainH, ROOF_H, style);

  // Chandeliers along nave
  for (let z = bz1 + 8; z < bz2 - 8; z += 8) {
    chandelier(grid, xMid, mainH - 1, z, style, 3);
  }

  // Wall torches in side aisles
  for (let z = bz1 + 4; z < bz2 - 3; z += 6) {
    grid.set(bx1 + 1, 3, z, style.torchE);
    grid.set(bx2 - 1, 3, z, style.torchW);
  }

  // ── Graveyard adjacent to cathedral — compositional secondary space ──
  const gyX1 = bx2 + 3;
  const gyX2 = Math.min(grid.width - 2, gyX1 + 8);
  const gyZ1 = bz1 + 5;
  const gyZ2 = Math.min(grid.length - 2, bz2 - 5);
  if (grid.inBounds(gyX2, 0, gyZ2)) {
    // Grass ground for graveyard
    for (let x = gyX1; x <= gyX2; x++) {
      for (let z = gyZ1; z <= gyZ2; z++) {
        if (grid.inBounds(x, 0, z)) grid.set(x, 0, z, 'minecraft:grass_block');
      }
    }
    // Gravestones (cobblestone walls as markers)
    for (let x = gyX1 + 1; x <= gyX2 - 1; x += 2) {
      for (let z = gyZ1 + 1; z <= gyZ2 - 1; z += 3) {
        if (grid.inBounds(x, 1, z))
          grid.set(x, 1, z, 'minecraft:cobblestone_wall');
      }
    }
    // Low stone wall around graveyard
    for (let x = gyX1; x <= gyX2; x++) {
      if (grid.inBounds(x, 1, gyZ1)) grid.set(x, 1, gyZ1, 'minecraft:stone_brick_wall');
      if (grid.inBounds(x, 1, gyZ2)) grid.set(x, 1, gyZ2, 'minecraft:stone_brick_wall');
    }
    for (let z = gyZ1; z <= gyZ2; z++) {
      if (grid.inBounds(gyX1, 1, z)) grid.set(gyX1, 1, z, 'minecraft:stone_brick_wall');
      if (grid.inBounds(gyX2, 1, z)) grid.set(gyX2, 1, z, 'minecraft:stone_brick_wall');
    }
    // Gate opening
    if (grid.inBounds(gyX1, 1, Math.floor((gyZ1 + gyZ2) / 2)))
      grid.set(gyX1, 1, Math.floor((gyZ1 + gyZ2) / 2), 'minecraft:air');
    // Path from cathedral to graveyard gate
    for (let x = bx2 + 1; x <= gyX1; x++) {
      if (grid.inBounds(x, 0, Math.floor((gyZ1 + gyZ2) / 2)))
        grid.set(x, 0, Math.floor((gyZ1 + gyZ2) / 2), 'minecraft:cobblestone');
    }
  }
  // Small parish house on the other side (west)
  const phX = Math.max(0, bx1 - 8);
  const phZ = bz1 + 5;
  placeOutbuilding(grid, phX, phZ, 6, 5, 4, style, 'gable');

  return grid;
}

// ─── Bridge ──────────────────────────────────────────────────────────────────

function generateBridge(
  _floors: number, style: StylePalette, _rooms: RoomType[] | undefined,
  bwOpt: number | undefined, blOpt: number | undefined, _rng: () => number
): BlockGrid {
  const bridgeW = bwOpt ?? 7;
  const bridgeL = blOpt ?? 35;
  const margin = 5;
  const towerSize = 5;
  const gw = bridgeW + margin * 2;
  const gl = bridgeL + margin * 2 + towerSize * 2;
  const archH = 8; // height of arch underneath
  const deckY = archH + 2;
  const gh = deckY + 15; // extra for towers

  const bx1 = margin;
  const bx2 = margin + bridgeW - 1;
  const bz1 = margin + towerSize;
  const bz2 = bz1 + bridgeL - 1;
  const cx = margin + Math.floor(bridgeW / 2);

  const grid = new BlockGrid(gw, gh, gl);

  // Bridge deck
  grid.fill(bx1, deckY, bz1, bx2, deckY, bz2, style.floorGround);

  // Parabolic arch underneath with inner ribs for depth
  const midZ = Math.floor((bz1 + bz2) / 2);
  const halfSpan = (bz2 - bz1) / 2;
  for (let z = bz1; z <= bz2; z++) {
    const t = (z - midZ) / halfSpan; // -1 to 1
    const archTop = deckY - 1 - Math.round(archH * (1 - t * t)); // parabola
    // Outer arch ribs at edges
    for (const x of [bx1, bx2]) {
      for (let y = Math.max(0, archTop); y <= deckY - 1; y++) {
        if (grid.inBounds(x, y, z)) grid.set(x, y, z, style.wall);
      }
    }
    // Inner arch ribs at bx1+1 and bx2-1 for structural depth from side view
    for (const x of [bx1 + 1, bx2 - 1]) {
      for (let y = Math.max(0, archTop); y <= deckY - 1; y++) {
        if (grid.inBounds(x, y, z)) grid.set(x, y, z, style.wallAccent);
      }
    }
    // Arch bottom face
    if (archTop >= 0 && grid.inBounds(cx, archTop, z)) {
      for (let x = bx1; x <= bx2; x++) {
        if (grid.inBounds(x, archTop, z)) grid.set(x, archTop, z, style.wall);
      }
    }
  }

  // Varied railings — alternating fence and stone wall accent posts
  for (let z = bz1; z <= bz2; z++) {
    // Every 4th block is a stone wall accent post, rest are fence
    const isAccent = (z - bz1) % 4 === 0;
    const railBlock = isAccent ? style.wallAccent : style.fence;
    grid.set(bx1, deckY + 1, z, railBlock);
    grid.set(bx2, deckY + 1, z, railBlock);
  }

  // Lamp posts every 4 blocks on railings — fence post topped with lantern
  for (let z = bz1 + 2; z <= bz2 - 2; z += 4) {
    grid.set(bx1, deckY + 2, z, style.fence);
    grid.set(bx1, deckY + 3, z, style.lanternFloor);
    grid.set(bx2, deckY + 2, z, style.fence);
    grid.set(bx2, deckY + 3, z, style.lanternFloor);
  }

  // Bench seating — stair-block benches facing outward, pairs every 8 blocks
  for (let z = bz1 + 4; z <= bz2 - 4; z += 8) {
    // Bench facing west (left side of bridge)
    if (grid.inBounds(bx1 + 1, deckY + 1, z))
      grid.set(bx1 + 1, deckY + 1, z, 'minecraft:stone_brick_stairs[facing=west]');
    // Bench facing east (right side of bridge)
    if (grid.inBounds(bx2 - 1, deckY + 1, z))
      grid.set(bx2 - 1, deckY + 1, z, 'minecraft:stone_brick_stairs[facing=east]');
  }

  // End towers (square, at both ends)
  for (const tz of [bz1 - towerSize, bz2 + 1]) {
    const tz2 = tz + towerSize - 1;
    // Tower foundation and walls
    grid.fill(bx1 - 1, 0, tz, bx2 + 1, 0, tz2, style.foundation);
    for (let y = 1; y <= deckY + 8; y++) {
      exteriorWalls(grid, bx1 - 1, y, tz, bx2 + 1, y, tz2, style);
    }
    // Tower floor at deck level
    grid.fill(bx1, deckY, tz, bx2, deckY, tz2, style.floorGround);
    // Tower battlements
    for (let x = bx1 - 1; x <= bx2 + 1; x += 2) {
      grid.set(x, deckY + 9, tz, style.wall);
      grid.set(x, deckY + 9, tz2, style.wall);
    }
    for (let z = tz; z <= tz2; z += 2) {
      grid.set(bx1 - 1, deckY + 9, z, style.wall);
      grid.set(bx2 + 1, deckY + 9, z, style.wall);
    }
    // Flat roof
    grid.fill(bx1 - 1, deckY + 8, tz, bx2 + 1, deckY + 8, tz2, style.ceiling);
    // Doorway from bridge into tower
    const doorZ = tz === bz1 - towerSize ? tz2 : tz;
    grid.set(cx, deckY + 1, doorZ, 'minecraft:air');
    grid.set(cx, deckY + 2, doorZ, 'minecraft:air');
    grid.set(cx, deckY + 3, doorZ, 'minecraft:air');
    // Windows
    windows(grid, bx1 - 1, tz, bx2 + 1, tz2, deckY + 3, deckY + 5, style, 3);
  }

  // Water indicator (blue blocks along edges below bridge)
  for (let z = bz1 + 2; z <= bz2 - 2; z++) {
    for (let x = bx1 - 2; x <= bx2 + 2; x++) {
      if (grid.inBounds(x, 0, z)) grid.set(x, 0, z, 'minecraft:water');
    }
  }

  // Center path accent — stone brick center strip with wallAccent side strips
  for (let z = bz1; z <= bz2; z++) {
    grid.set(cx, deckY, z, 'minecraft:stone_bricks');
    // Side accent strips flanking center
    if (grid.inBounds(cx - 1, deckY, z))
      grid.set(cx - 1, deckY, z, style.wallAccent);
    if (grid.inBounds(cx + 1, deckY, z))
      grid.set(cx + 1, deckY, z, style.wallAccent);
  }

  // ── Arch buttresses — support pillars underneath at regular intervals ──
  for (let z = bz1 + 4; z <= bz2 - 4; z += 6) {
    for (const x of [bx1 - 1, bx2 + 1]) {
      if (!grid.inBounds(x, 0, z)) continue;
      // Tapered buttress: wider at base, narrows upward
      for (let y = 0; y < deckY; y++) {
        grid.set(x, y, z, style.wall);
        // Wider base blocks on first 2 layers
        if (y < 2 && grid.inBounds(x + (x < cx ? -1 : 1), y, z))
          grid.set(x + (x < cx ? -1 : 1), y, z, style.wallAccent);
      }
    }
  }

  // ── Tower banners — decorative banners on tower exteriors ──
  for (const tz of [bz1 - towerSize, bz2 + 1]) {
    const tz2 = tz + towerSize - 1;
    const bannerY = deckY + 5;
    // Banners on north and south faces of each tower
    if (grid.inBounds(cx, bannerY, tz)) grid.set(cx, bannerY, tz, style.bannerN);
    if (grid.inBounds(cx, bannerY, tz2)) grid.set(cx, bannerY, tz2, style.bannerS);
    // Tower-top lanterns at corners
    for (const tx of [bx1 - 1, bx2 + 1]) {
      if (grid.inBounds(tx, deckY + 9, tz))
        grid.set(tx, deckY + 9, tz, style.lanternFloor);
      if (grid.inBounds(tx, deckY + 9, tz2))
        grid.set(tx, deckY + 9, tz2, style.lanternFloor);
    }
  }

  // ── Arch keystone — accent block at the peak of each arch rib ──
  grid.set(bx1, deckY - 1, midZ, style.wallAccent);
  grid.set(bx2, deckY - 1, midZ, style.wallAccent);

  // ── Deck surface variation — cobblestone/brick pattern instead of flat ──
  for (let z = bz1; z <= bz2; z++) {
    for (let x = bx1 + 1; x <= bx2 - 1; x++) {
      if (grid.inBounds(x, deckY, z)) {
        // Checkerboard pattern of two stone types
        const block = (x + z) % 2 === 0 ? 'minecraft:stone_bricks' : 'minecraft:polished_andesite';
        grid.set(x, deckY, z, block);
      }
    }
  }

  // ── Statue pedestals at bridge midpoint — guardian figures ──
  for (const sx of [bx1 + 1, bx2 - 1]) {
    if (grid.inBounds(sx, deckY + 1, midZ))
      grid.set(sx, deckY + 1, midZ, style.wallAccent); // pedestal
    if (grid.inBounds(sx, deckY + 2, midZ))
      grid.set(sx, deckY + 2, midZ, 'minecraft:armor_stand'); // statue
  }

  // ── Hanging chain lanterns beneath deck for underside detail ──
  for (let z = bz1 + 4; z <= bz2 - 4; z += 6) {
    if (grid.inBounds(cx, deckY - 1, z))
      grid.set(cx, deckY - 1, z, 'minecraft:chain');
    if (grid.inBounds(cx, deckY - 2, z))
      grid.set(cx, deckY - 2, z, style.lanternFloor);
  }

  // ── Gatehouse / toll booth at bridge entrance (south end) ──
  const ghBX1 = bx1 - 2;
  const ghBX2 = bx2 + 2;
  const ghBZ1 = bz2 + 1;
  const ghBZ2 = ghBZ1 + 4;
  const ghBH = 5;
  if (grid.inBounds(ghBX2, ghBH + 3, ghBZ2)) {
    for (let y = deckY + 1; y <= deckY + ghBH; y++) {
      for (let x = ghBX1; x <= ghBX2; x++) {
        grid.set(x, y, ghBZ1, style.wall);
        grid.set(x, y, ghBZ2, style.wall);
      }
      for (let z = ghBZ1; z <= ghBZ2; z++) {
        grid.set(ghBX1, y, z, style.wall);
        grid.set(ghBX2, y, z, style.wall);
      }
    }
    // Gatehouse floor
    for (let x = ghBX1; x <= ghBX2; x++) {
      for (let z = ghBZ1; z <= ghBZ2; z++) {
        if (grid.inBounds(x, deckY, z))
          grid.set(x, deckY, z, style.floorGround);
      }
    }
    // Passage through gatehouse
    for (let y = deckY + 1; y <= deckY + 3; y++) {
      grid.set(cx, y, ghBZ1, 'minecraft:air');
      grid.set(cx, y, ghBZ2, 'minecraft:air');
      grid.set(cx + 1, y, ghBZ1, 'minecraft:air');
      grid.set(cx + 1, y, ghBZ2, 'minecraft:air');
    }
    // Gatehouse battlements
    for (let x = ghBX1; x <= ghBX2; x += 2) {
      if (grid.inBounds(x, deckY + ghBH + 1, ghBZ1))
        grid.set(x, deckY + ghBH + 1, ghBZ1, style.wall);
      if (grid.inBounds(x, deckY + ghBH + 1, ghBZ2))
        grid.set(x, deckY + ghBH + 1, ghBZ2, style.wall);
    }
    // Windows on gatehouse
    if (grid.inBounds(cx, deckY + 3, ghBZ1 + 2))
      grid.set(ghBX1, deckY + 3, ghBZ1 + 2, style.window);
    if (grid.inBounds(ghBX2, deckY + 3, ghBZ1 + 2))
      grid.set(ghBX2, deckY + 3, ghBZ1 + 2, style.window);
  }

  return grid;
}

// ─── Windmill ────────────────────────────────────────────────────────────────

function generateWindmill(
  floors: number, style: StylePalette, _rooms: RoomType[] | undefined,
  bwOpt: number | undefined, _blOpt: number | undefined, _rng: () => number
): BlockGrid {
  const baseR = bwOpt ? Math.floor(bwOpt / 2) : 6;
  const numFloors = Math.max(floors, 3);
  const margin = 5;
  const diam = baseR * 2 + 1;
  const gw = diam + margin * 2 + 10; // extra for blades
  const gl = diam + margin * 2 + 10;
  const gh = numFloors * STORY_H + 20; // extra for blades

  const cx = Math.floor(gw / 2);
  const cz = Math.floor(gl / 2);
  const grid = new BlockGrid(gw, gh, gl);

  // Tapering circular tower
  for (let story = 0; story < numFloors; story++) {
    const by = story * STORY_H;
    const cy = by + STORY_H;
    // Radius decreases per floor for taper
    const r = Math.max(3, baseR - story);

    // Floor
    fillCircle(grid, cx, by, cz, r - 1, story === 0 ? style.floorGround : style.floorUpper);

    // Walls
    for (let y = by + 1; y < cy; y++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist >= r - 0.5 && dist <= r + 0.5) {
            grid.set(cx + dx, y, cz + dz, style.wall);
          }
        }
      }
    }

    // Ceiling
    if (story === numFloors - 1) {
      fillCircle(grid, cx, cy, cz, r, style.ceiling);
    }

    // Windows
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
      if (grid.inBounds(cx + dx, by + 2, cz + dz)) {
        grid.set(cx + dx, by + 2, cz + dz, style.window);
        grid.set(cx + dx, by + 3, cz + dz, style.window);
      }
    }

    // Spiral stairs (except top floor)
    if (story < numFloors - 1) {
      const angle = story * Math.PI * 0.5;
      for (let step = 0; step < 5; step++) {
        const sa = angle + (step / 5) * Math.PI * 0.5;
        const sx = cx + Math.round(Math.cos(sa) * (r - 2));
        const sz = cz + Math.round(Math.sin(sa) * (r - 2));
        const sy = by + 1 + step;
        if (grid.inBounds(sx, sy, sz)) {
          grid.set(sx, sy, sz, 'minecraft:oak_stairs[facing=south]');
          for (let cly = sy + 1; cly < sy + 4; cly++) {
            if (grid.inBounds(sx, cly, sz)) grid.set(sx, cly, sz, 'minecraft:air');
          }
        }
      }
    }
  }

  // Ground floor: grindstone + hay storage
  grid.set(cx + 2, 1, cz, 'minecraft:grindstone[face=floor,facing=north]');
  grid.set(cx - 2, 1, cz, 'minecraft:hay_block');
  grid.set(cx - 2, 2, cz, 'minecraft:hay_block');
  grid.set(cx - 2, 1, cz + 1, 'minecraft:hay_block');
  // Extra grain storage along wall
  if (grid.inBounds(cx - 2, 1, cz - 1))
    grid.set(cx - 2, 1, cz - 1, 'minecraft:hay_block');
  if (grid.inBounds(cx + 2, 1, cz - 2))
    grid.set(cx + 2, 1, cz - 2, 'minecraft:hay_block');
  grid.addBarrel(cx + 2, 1, cz + 2, 'up', [
    { slot: 0, id: 'minecraft:wheat', count: 64 },
    { slot: 1, id: 'minecraft:bread', count: 32 },
  ]);

  // Front door
  grid.set(cx, 1, cz - baseR, style.doorLowerS);
  grid.set(cx, 2, cz - baseR, style.doorUpperS);
  grid.set(cx, 3, cz - baseR, 'minecraft:air');

  // Blade level — at the top floor
  const bladeY = (numFloors - 1) * STORY_H + 3;
  const topR = Math.max(3, baseR - (numFloors - 1));

  // 4-arm blade structure extending from front face (z = cz - topR)
  const bladeLen = baseR + 3;
  const bladeFaceZ = cz - topR - 1;

  // Blade hub
  grid.set(cx, bladeY, bladeFaceZ, style.timber);

  // 4 blades: up, down, left, right from hub
  const bladeDirections: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  for (const [dx, dy] of bladeDirections) {
    for (let i = 1; i <= bladeLen; i++) {
      const bx = cx + dx * i;
      const by = bladeY + dy * i;
      if (grid.inBounds(bx, by, bladeFaceZ)) {
        grid.set(bx, by, bladeFaceZ, style.fence);
        // Wool sail on one side of each arm
        if (i >= 2 && i <= bladeLen - 1) {
          const sailX = bx + (dy !== 0 ? 1 : 0);
          const sailY = by + (dx !== 0 ? 1 : 0);
          if (grid.inBounds(sailX, sailY, bladeFaceZ))
            grid.set(sailX, sailY, bladeFaceZ, 'minecraft:white_wool');
        }
      }
    }
  }

  // Balcony at blade level (ring around tower)
  const balcR = topR + 2;
  for (let dx = -balcR; dx <= balcR; dx++) {
    for (let dz = -balcR; dz <= balcR; dz++) {
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= topR + 0.5 && dist <= balcR + 0.5) {
        if (grid.inBounds(cx + dx, bladeY - 1, cz + dz))
          grid.set(cx + dx, bladeY - 1, cz + dz, style.slabBottom);
      }
      if (dist >= balcR - 0.5 && dist <= balcR + 0.5) {
        if (grid.inBounds(cx + dx, bladeY, cz + dz))
          grid.set(cx + dx, bladeY, cz + dz, style.fence);
      }
    }
  }

  // Conical roof
  const roofBase = numFloors * STORY_H;
  const roofR = Math.max(3, baseR - (numFloors - 1));
  for (let layer = 0; layer <= roofR + 2; layer++) {
    const ry = roofBase + 1 + layer;
    const rr = roofR + 1 - layer;
    if (rr <= 0 || !grid.inBounds(0, ry, 0)) break;
    for (let dx = -rr; dx <= rr; dx++) {
      for (let dz = -rr; dz <= rr; dz++) {
        if (Math.sqrt(dx * dx + dz * dz) <= rr + 0.5) {
          if (grid.inBounds(cx + dx, ry, cz + dz))
            grid.set(cx + dx, ry, cz + dz, style.roofS);
        }
      }
    }
  }

  // Torches inside
  for (let story = 0; story < numFloors; story++) {
    const r = Math.max(3, baseR - story);
    for (const [tx, tz] of [[cx + r - 1, cz], [cx - r + 1, cz], [cx, cz + r - 1], [cx, cz - r + 1]]) {
      if (grid.inBounds(tx, story * STORY_H + 3, tz))
        grid.set(tx, story * STORY_H + 3, tz, style.lantern);
    }
  }

  // ── Windmill exterior detail — grain sacks, weathered base, outdoor elements ──
  // Grain sack pile outside entrance
  const doorZw = cz - baseR;
  if (grid.inBounds(cx + 2, 1, doorZw - 1))
    grid.set(cx + 2, 1, doorZw - 1, 'minecraft:hay_block');
  if (grid.inBounds(cx + 3, 1, doorZw - 1))
    grid.set(cx + 3, 1, doorZw - 1, 'minecraft:hay_block');
  if (grid.inBounds(cx + 2, 2, doorZw - 1))
    grid.set(cx + 2, 2, doorZw - 1, 'minecraft:hay_block');
  // Barrel for flour storage
  if (grid.inBounds(cx - 2, 1, doorZw - 1))
    grid.addBarrel(cx - 2, 1, doorZw - 1, 'up', [
      { slot: 0, id: 'minecraft:bread', count: 64 },
    ]);
  // Weathered base walls — mix in cobblestone at ground level
  for (let dx = -baseR; dx <= baseR; dx++) {
    for (let dz = -baseR; dz <= baseR; dz++) {
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= baseR - 0.5 && dist <= baseR + 0.5) {
        const bx = cx + dx;
        const bz = cz + dz;
        if (grid.inBounds(bx, 1, bz) && grid.get(bx, 1, bz) === style.wall) {
          // 20% chance to replace ground-level wall blocks with cobblestone
          if ((dx * 7 + dz * 13) % 5 === 0)
            grid.set(bx, 1, bz, 'minecraft:cobblestone');
        }
      }
    }
  }
  // Outdoor path — cobblestone path leading to door
  for (let pz = doorZw - 2; pz >= doorZw - 5; pz--) {
    if (grid.inBounds(cx, 0, pz))
      grid.set(cx, 0, pz, 'minecraft:cobblestone');
    if (grid.inBounds(cx - 1, 0, pz))
      grid.set(cx - 1, 0, pz, 'minecraft:cobblestone');
  }
  // Lantern by door
  if (grid.inBounds(cx - 1, 1, doorZw - 1))
    grid.set(cx - 1, 1, doorZw - 1, style.lanternFloor);

  // ── Grain storage shed + fenced wheat field — windmill composition ──
  // Shed to the east of windmill
  const wShedX = cx + baseR + 4;
  const wShedZ = cz - 2;
  if (grid.inBounds(wShedX + 5, 5, wShedZ + 4))
    placeOutbuilding(grid, wShedX, wShedZ, 5, 5, 3, style, 'lean-to');
  // Path from windmill to shed
  for (let x = cx + baseR + 1; x <= wShedX; x++) {
    if (grid.inBounds(x, 0, cz))
      grid.set(x, 0, cz, 'minecraft:cobblestone');
  }
  // Wheat field (south of windmill, fenced)
  const fieldX1 = cx - baseR - 1;
  const fieldX2 = cx + baseR + 1;
  const fieldZ1 = cz + baseR + 3;
  const fieldZ2 = Math.min(grid.length - 2, fieldZ1 + 6);
  if (grid.inBounds(fieldX2, 0, fieldZ2)) {
    for (let x = fieldX1; x <= fieldX2; x++) {
      for (let z = fieldZ1; z <= fieldZ2; z++) {
        if (grid.inBounds(x, 0, z)) {
          grid.set(x, 0, z, 'minecraft:farmland[moisture=7]');
          if (grid.inBounds(x, 1, z))
            grid.set(x, 1, z, 'minecraft:wheat[age=7]');
        }
      }
    }
    // Fence around field
    for (let x = fieldX1 - 1; x <= fieldX2 + 1; x++) {
      if (grid.inBounds(x, 1, fieldZ1 - 1)) grid.set(x, 1, fieldZ1 - 1, style.fence);
      if (grid.inBounds(x, 1, fieldZ2 + 1)) grid.set(x, 1, fieldZ2 + 1, style.fence);
    }
    for (let z = fieldZ1 - 1; z <= fieldZ2 + 1; z++) {
      if (grid.inBounds(fieldX1 - 1, 1, z)) grid.set(fieldX1 - 1, 1, z, style.fence);
      if (grid.inBounds(fieldX2 + 1, 1, z)) grid.set(fieldX2 + 1, 1, z, style.fence);
    }
  }

  return grid;
}

// ─── Marketplace ─────────────────────────────────────────────────────────────

function generateMarketplace(
  _floors: number, style: StylePalette, _rooms: RoomType[] | undefined,
  bwOpt: number | undefined, blOpt: number | undefined, _rng: () => number
): BlockGrid {
  const bw = bwOpt ?? 25;
  const bl = blOpt ?? 20;
  const margin = 3;
  const gw = bw + margin * 2;
  const gl = bl + margin * 2;
  const gh = 12;

  const bx1 = margin;
  const bx2 = margin + bw - 1;
  const bz1 = margin;
  const bz2 = margin + bl - 1;
  const xMid = margin + Math.floor(bw / 2);
  const zMid = margin + Math.floor(bl / 2);

  const grid = new BlockGrid(gw, gh, gl);

  // Ground floor
  grid.fill(bx1, 0, bz1, bx2, 0, bz2, style.floorGround);

  // Perimeter low wall with fence posts
  for (let x = bx1; x <= bx2; x++) {
    grid.set(x, 1, bz1, style.wall);
    grid.set(x, 1, bz2, style.wall);
  }
  for (let z = bz1; z <= bz2; z++) {
    grid.set(bx1, 1, z, style.wall);
    grid.set(bx2, 1, z, style.wall);
  }
  // Fence on top of low wall
  for (let x = bx1; x <= bx2; x += 2) {
    grid.set(x, 2, bz1, style.fence);
    grid.set(x, 2, bz2, style.fence);
  }
  for (let z = bz1; z <= bz2; z += 2) {
    grid.set(bx1, 2, z, style.fence);
    grid.set(bx2, 2, z, style.fence);
  }

  // Gates (openings at mid-points)
  for (let dy = 1; dy <= 2; dy++) {
    grid.set(xMid, dy, bz1, 'minecraft:air');
    grid.set(xMid - 1, dy, bz1, 'minecraft:air');
    grid.set(xMid, dy, bz2, 'minecraft:air');
    grid.set(xMid - 1, dy, bz2, 'minecraft:air');
  }

  // Covered central walkway (E-W through middle)
  for (let x = bx1 + 2; x <= bx2 - 2; x++) {
    grid.set(x, 0, zMid, 'minecraft:polished_deepslate');
    // Roof over walkway
    grid.set(x, 4, zMid - 1, style.slabBottom);
    grid.set(x, 4, zMid, style.slabBottom);
    grid.set(x, 4, zMid + 1, style.slabBottom);
  }
  // Walkway support columns
  for (let x = bx1 + 3; x <= bx2 - 3; x += 4) {
    for (let y = 1; y <= 3; y++) {
      grid.set(x, y, zMid - 1, style.fence);
      grid.set(x, y, zMid + 1, style.fence);
    }
  }

  // Stall grid — 2 rows, north and south of walkway
  const stallItems = [
    'minecraft:apple', 'minecraft:bread', 'minecraft:emerald',
    'minecraft:iron_ingot', 'minecraft:book', 'minecraft:golden_apple',
    'minecraft:diamond', 'minecraft:potion',
  ];
  // Expanded stall goods — more workstation variety
  const stallGoods = [
    'minecraft:barrel', 'minecraft:crafting_table', 'minecraft:anvil', 'minecraft:cauldron',
    'minecraft:fletching_table', 'minecraft:loom', 'minecraft:composter', 'minecraft:smoker',
  ];
  // Flower pots for stall corner decoration
  const stallFlowers = [
    'minecraft:potted_poppy', 'minecraft:potted_dandelion', 'minecraft:potted_blue_orchid',
    'minecraft:potted_allium', 'minecraft:potted_cornflower', 'minecraft:potted_red_tulip',
  ];
  let stallIdx = 0;
  for (const stallRow of [bz1 + 3, bz2 - 3]) {
    for (let sx = bx1 + 3; sx <= bx2 - 5; sx += 6) {
      // Stall posts
      for (let y = 1; y <= 3; y++) {
        grid.set(sx, y, stallRow, style.fence);
        grid.set(sx + 3, y, stallRow, style.fence);
      }
      // Slab roof
      grid.fill(sx, 4, stallRow - 1, sx + 3, 4, stallRow + 1, style.slabBottom);

      // Awnings on alternating stalls — second-story slab extension with support
      if (stallIdx % 2 === 0) {
        const awningZ = stallRow < zMid ? stallRow - 2 : stallRow + 2;
        if (grid.inBounds(sx, 5, awningZ)) {
          grid.fill(sx, 5, Math.min(stallRow, awningZ), sx + 3, 5, Math.max(stallRow, awningZ), style.slabBottom);
          // Support posts for awning
          grid.set(sx, 4, awningZ, style.fence);
          grid.set(sx + 3, 4, awningZ, style.fence);
        }
      }

      // Counter / display table
      grid.set(sx + 1, 1, stallRow, style.fence);
      grid.set(sx + 1, 2, stallRow, style.carpet);
      grid.set(sx + 2, 1, stallRow, style.fence);
      grid.set(sx + 2, 2, stallRow, style.carpet);
      // Display items
      grid.addChest(sx + 1, 1, stallRow + 1, 'north', [
        { slot: 0, id: stallItems[stallIdx % stallItems.length], count: 32 },
      ]);
      // Varied stall goods on counter
      grid.set(sx + 1, 3, stallRow, stallGoods[stallIdx % stallGoods.length]);
      // Lantern
      grid.set(sx + 2, 3, stallRow, style.lantern);

      // Flower pots at stall corners
      if (grid.inBounds(sx, 1, stallRow - 1))
        grid.set(sx, 1, stallRow - 1, stallFlowers[stallIdx % stallFlowers.length]);
      if (grid.inBounds(sx + 3, 1, stallRow + 1))
        grid.set(sx + 3, 1, stallRow + 1, stallFlowers[(stallIdx + 1) % stallFlowers.length]);

      stallIdx++;
    }
  }

  // Seating benches — stair blocks along central walkway, every 6 blocks
  for (let x = bx1 + 4; x <= bx2 - 4; x += 6) {
    // North-facing bench on south side of walkway
    if (grid.inBounds(x, 1, zMid + 2))
      grid.set(x, 1, zMid + 2, 'minecraft:oak_stairs[facing=north]');
    // South-facing bench on north side of walkway
    if (grid.inBounds(x, 1, zMid - 2))
      grid.set(x, 1, zMid - 2, 'minecraft:oak_stairs[facing=south]');
  }

  // Well/fountain in center
  grid.fill(xMid - 1, 0, zMid - 1, xMid + 1, 0, zMid + 1, 'minecraft:stone_bricks');
  grid.set(xMid, 0, zMid, 'minecraft:water_cauldron[level=3]');
  for (const [wx, wz] of [[xMid - 1, zMid - 1], [xMid + 1, zMid - 1],
                            [xMid - 1, zMid + 1], [xMid + 1, zMid + 1]]) {
    grid.set(wx, 1, wz, style.fence);
    grid.set(wx, 2, wz, style.fence);
  }
  grid.fill(xMid - 1, 3, zMid - 1, xMid + 1, 3, zMid + 1, style.slabBottom);
  grid.set(xMid, 2, zMid, 'minecraft:chain');
  grid.set(xMid, 1, zMid, style.lanternFloor);

  // Path from gates to center
  for (let z = bz1 + 1; z <= bz2 - 1; z++) {
    grid.set(xMid, 0, z, 'minecraft:polished_deepslate');
  }

  // Corner lanterns
  grid.set(bx1 + 1, 1, bz1 + 1, style.lanternFloor);
  grid.set(bx2 - 1, 1, bz1 + 1, style.lanternFloor);
  grid.set(bx1 + 1, 1, bz2 - 1, style.lanternFloor);
  grid.set(bx2 - 1, 1, bz2 - 1, style.lanternFloor);

  // Banners at gates
  grid.set(xMid - 2, 3, bz1, style.bannerS);
  grid.set(xMid + 1, 3, bz1, style.bannerS);
  grid.set(xMid - 2, 3, bz2, style.bannerN);
  grid.set(xMid + 1, 3, bz2, style.bannerN);

  // Perimeter banners — decorative banners on fence posts every 8 blocks
  for (let x = bx1 + 4; x <= bx2 - 4; x += 8) {
    if (grid.inBounds(x, 2, bz1)) grid.set(x, 2, bz1, style.bannerS);
    if (grid.inBounds(x, 2, bz2)) grid.set(x, 2, bz2, style.bannerN);
  }

  // ── Marketplace detail — carpet path accents + hanging chains + trees ──
  // Carpet accent pattern along main walkway
  const carpetTypes = [
    'minecraft:red_carpet', 'minecraft:orange_carpet',
    'minecraft:yellow_carpet', 'minecraft:light_blue_carpet',
  ];
  for (let x = bx1 + 2; x <= bx2 - 2; x += 2) {
    const ci = Math.abs(x - xMid) % carpetTypes.length;
    if (grid.inBounds(x, 1, zMid) && grid.get(x, 1, zMid) === 'minecraft:air')
      grid.set(x, 1, zMid, carpetTypes[ci]);
  }
  // Hanging chain lanterns along covered walkway
  for (let x = bx1 + 5; x <= bx2 - 5; x += 4) {
    if (grid.inBounds(x, 3, zMid)) {
      grid.set(x, 3, zMid, 'minecraft:chain');
      if (grid.inBounds(x, 2, zMid) && grid.get(x, 2, zMid) === 'minecraft:air')
        grid.set(x, 2, zMid, style.lantern);
    }
  }
  // Small trees at plaza corners for shade
  for (const [tx, tz] of [[bx1 + 2, bz1 + 2], [bx2 - 2, bz2 - 2]] as [number, number][]) {
    if (grid.inBounds(tx, 1, tz)) placeTree(grid, tx, 1, tz, 'oak', 3);
  }
  // Potted plants along perimeter wall
  for (let x = bx1 + 2; x <= bx2 - 2; x += 5) {
    if (grid.inBounds(x, 2, bz1 + 1))
      grid.set(x, 2, bz1 + 1, 'minecraft:potted_cornflower');
    if (grid.inBounds(x, 2, bz2 - 1))
      grid.set(x, 2, bz2 - 1, 'minecraft:potted_allium');
  }

  return grid;
}

// ─── Village ─────────────────────────────────────────────────────────────────

function generateVillage(
  floors: number, style: StylePalette, rooms: RoomType[] | undefined,
  _bwOpt: number | undefined, _blOpt: number | undefined, rng: () => number
): BlockGrid {
  const gridSize = 80;
  const margin = 5;
  const gw = gridSize + margin * 2;
  const gl = gridSize + margin * 2;
  const gh = floors * STORY_H + ROOF_H + 15;

  const grid = new BlockGrid(gw, gh, gl);

  // Green ground layer
  grid.fill(margin, 0, margin, margin + gridSize - 1, 0, margin + gridSize - 1, 'minecraft:grass_block');

  const cx = margin + Math.floor(gridSize / 2);
  const cz = margin + Math.floor(gridSize / 2);

  // ── Village plaza — stone brick circle (radius 6) around center well ──
  const plazaR = 6;
  fillCircle(grid, cx, 0, cz, plazaR, 'minecraft:stone_bricks');
  // Plaza rim accent ring
  for (let dx = -plazaR; dx <= plazaR; dx++) {
    for (let dz = -plazaR; dz <= plazaR; dz++) {
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > plazaR - 0.5 && dist <= plazaR + 0.5) {
        if (grid.inBounds(cx + dx, 0, cz + dz))
          grid.set(cx + dx, 0, cz + dz, 'minecraft:polished_deepslate');
      }
    }
  }

  // Building placement — ring layout around central plaza
  // Houses face south (high-Z porch). South-side buildings get Z-flipped to face inward.
  const buildingSpots: { x: number; z: number; w: number; l: number; type: 'house' | 'tower' | 'marketplace'; doorX: number; doorZ: number; flipZ: boolean }[] = [];

  const bldgMargin = 3; // internal margin in sub-grids
  // Ring radius: center of buildings from village center (28 prevents overlap)
  const ringR = 28;

  // Place buildings at 6 angular positions around the plaza (clock positions)
  // Position 0 (north): marketplace
  // Position 1-4: houses
  // Position 5: tower
  const angles = [
    { angle: 0, type: 'marketplace' as const },   // north
    { angle: 60, type: 'house' as const },          // NE
    { angle: 120, type: 'house' as const },         // SE
    { angle: 180, type: 'house' as const },         // south
    { angle: 240, type: 'house' as const },         // SW
    { angle: 300, type: 'tower' as const },         // NW
  ];

  for (const slot of angles) {
    const rad = (slot.angle * Math.PI) / 180;
    // Building center in village coordinates
    const bCenterX = cx + Math.round(ringR * Math.sin(rad));
    const bCenterZ = cz - Math.round(ringR * Math.cos(rad));
    // South half of village = flip so porch faces north (toward center)
    const needFlip = slot.angle > 90 && slot.angle < 270;

    if (slot.type === 'marketplace') {
      const mpW = 18, mpL = 14;
      const mpX = bCenterX - Math.floor(mpW / 2) - bldgMargin;
      const mpZ = bCenterZ - Math.floor(mpL / 2) - bldgMargin;
      buildingSpots.push({
        x: mpX, z: mpZ, w: mpW, l: mpL, type: 'marketplace',
        doorX: bCenterX, doorZ: needFlip ? mpZ + bldgMargin : mpZ + bldgMargin + mpL,
        flipZ: needFlip,
      });
    } else if (slot.type === 'tower') {
      const twSize = 10;
      const twX = bCenterX - Math.floor(twSize / 2) - bldgMargin;
      const twZ = bCenterZ - Math.floor(twSize / 2) - bldgMargin;
      buildingSpots.push({
        x: twX, z: twZ, w: twSize, l: twSize, type: 'tower',
        doorX: bCenterX, doorZ: needFlip ? twZ + bldgMargin : twZ + bldgMargin + twSize,
        flipZ: needFlip,
      });
    } else {
      const hw = 13 + Math.floor(rng() * 4);  // 13-16
      const hl = 11 + Math.floor(rng() * 4);  // 11-14
      const hx = bCenterX - Math.floor(hw / 2) - bldgMargin;
      const hz = bCenterZ - Math.floor(hl / 2) - bldgMargin;
      buildingSpots.push({
        x: hx, z: hz, w: hw, l: hl, type: 'house',
        doorX: bCenterX, doorZ: needFlip ? hz + bldgMargin : hz + bldgMargin + hl,
        flipZ: needFlip,
      });
    }
  }

  // Generate each building as a sub-structure and paste blocks
  for (const spot of buildingSpots) {
    let subGrid: BlockGrid;
    const houseFloors = rng() < 0.5 ? 1 : 2; // random 1-2 stories
    switch (spot.type) {
      case 'house':
        subGrid = generateHouse(Math.min(floors, houseFloors), style, rooms, spot.w, spot.l, rng);
        break;
      case 'tower':
        subGrid = generateTower(Math.min(floors, 3), style, rooms, spot.w, undefined, rng);
        break;
      case 'marketplace':
        subGrid = generateMarketplace(1, style, undefined, spot.w, spot.l, rng);
        break;
    }
    if (spot.flipZ) {
      pasteGridFlipZ(grid, subGrid, spot.x, 0, spot.z);
    } else {
      pasteGrid(grid, subGrid, spot.x, 0, spot.z);
    }
  }

  // ── Upgraded paths — route from each building's door to the center well ──
  const wellX = cx;
  const wellZ = cz;
  for (const spot of buildingSpots) {
    const sx = spot.doorX;
    const sz = spot.doorZ;
    // L-shaped path: first move horizontally (X) to align with well, then vertically (Z)
    const startX = Math.min(sx, wellX);
    const endX = Math.max(sx, wellX);
    for (let x = startX; x <= endX; x++) {
      for (let dz = -1; dz <= 0; dz++) {
        if (grid.inBounds(x, 0, sz + dz))
          grid.set(x, 0, sz + dz, 'minecraft:stone_bricks');
      }
    }
    // Vertical segment from door-Z to well-Z
    const startZ = Math.min(sz, wellZ);
    const endZ = Math.max(sz, wellZ);
    for (let z = startZ; z <= endZ; z++) {
      for (let dx = -1; dx <= 0; dx++) {
        if (grid.inBounds(wellX + dx, 0, z))
          grid.set(wellX + dx, 0, z, 'minecraft:stone_bricks');
      }
    }
  }

  // Central well/fountain on plaza
  grid.fill(wellX - 1, 0, wellZ - 1, wellX + 1, 0, wellZ + 1, 'minecraft:chiseled_stone_bricks');
  grid.set(wellX, 0, wellZ, 'minecraft:water_cauldron[level=3]');
  for (const [wx, wz] of [[wellX - 1, wellZ - 1], [wellX + 1, wellZ - 1],
                            [wellX - 1, wellZ + 1], [wellX + 1, wellZ + 1]]) {
    grid.set(wx, 1, wz, style.fence);
    grid.set(wx, 2, wz, style.fence);
  }
  grid.fill(wellX - 1, 3, wellZ - 1, wellX + 1, 3, wellZ + 1, style.slabBottom);
  grid.set(wellX, 2, wellZ, 'minecraft:chain');
  grid.set(wellX, 1, wellZ, style.lanternFloor);
  // Lanterns on plaza rim
  for (const [lx, lz] of [[cx - plazaR, cz], [cx + plazaR, cz], [cx, cz - plazaR], [cx, cz + plazaR]]) {
    if (grid.inBounds(lx, 1, lz)) grid.set(lx, 1, lz, style.lanternFloor);
  }

  // ── Perimeter fence with gate openings at cardinal midpoints ──
  const fenceMin = margin;
  const fenceMax = margin + gridSize - 1;
  const fenceMidX = margin + Math.floor(gridSize / 2);
  const fenceMidZ = margin + Math.floor(gridSize / 2);
  for (let x = fenceMin; x <= fenceMax; x++) {
    // North and south fence — skip 3-block gap at midpoint
    if (Math.abs(x - fenceMidX) > 1) {
      grid.set(x, 1, fenceMin, style.fence);
      grid.set(x, 1, fenceMax, style.fence);
    }
  }
  for (let z = fenceMin; z <= fenceMax; z++) {
    // East and west fence — skip 3-block gap at midpoint
    if (Math.abs(z - fenceMidZ) > 1) {
      grid.set(fenceMin, 1, z, style.fence);
      grid.set(fenceMax, 1, z, style.fence);
    }
  }

  // ── Garden plots in gaps between buildings ──
  const gardenSpots: [number, number, number, number][] = [
    [cx - 8, cz + 12, cx - 4, cz + 16],
    [cx + 8, cz - 16, cx + 12, cz - 12],
    [cx - 18, cz - 4, cx - 14, cz],
  ];
  for (const [gx1, gz1, gx2, gz2] of gardenSpots) {
    if (grid.inBounds(gx1, 0, gz1) && grid.inBounds(gx2, 0, gz2)) {
      placeGarden(grid, gx1, gz1, gx2, gz2, 0, rng);
    }
  }

  // Scattered trees using terrain primitive
  const treePositions: [number, number][] = [
    [cx - 20, cz + 15], [cx + 20, cz + 15],
    [cx - 20, cz - 15], [cx + 25, cz - 20],
    [cx + 5, cz + 25], [cx - 10, cz - 25],
  ];
  for (const [tx, tz] of treePositions) {
    if (!grid.inBounds(tx, 0, tz)) continue;
    const trunkH = 4 + Math.floor(rng() * 3);
    placeTree(grid, tx, 1, tz, 'oak', trunkH);
  }

  // Additional trees between buildings for a lived-in feel
  const extraTrees: [number, number][] = [
    [cx - 5, cz + 5], [cx + 12, cz + 10], [cx - 15, cz],
  ];
  for (const [tx, tz] of extraTrees) {
    if (grid.inBounds(tx, 0, tz) && grid.get(tx, 0, tz) === 'minecraft:grass_block') {
      placeTree(grid, tx, 1, tz, 'birch', 4 + Math.floor(rng() * 2));
    }
  }

  // Lanterns along paths at intersections
  for (let z = margin + 10; z < margin + gridSize - 10; z += 10) {
    if (grid.inBounds(wellX + 2, 1, z))
      grid.set(wellX + 2, 1, z, style.lanternFloor);
  }

  return grid;
}

/** Paste a source grid into a target grid at the given offset (blocks + block entities) */
function pasteGrid(
  target: BlockGrid, source: BlockGrid,
  offsetX: number, offsetY: number, offsetZ: number
): void {
  for (let x = 0; x < source.width; x++) {
    for (let y = 0; y < source.height; y++) {
      for (let z = 0; z < source.length; z++) {
        const block = source.get(x, y, z);
        if (block !== 'minecraft:air') {
          const tx = x + offsetX;
          const ty = y + offsetY;
          const tz = z + offsetZ;
          if (target.inBounds(tx, ty, tz)) {
            target.set(tx, ty, tz, block);
          }
        }
      }
    }
  }
  // Copy block entities with adjusted coordinates
  for (const be of source.blockEntities) {
    const [bx, by, bz] = be.pos;
    target.blockEntities.push({
      ...be,
      pos: [bx + offsetX, by + offsetY, bz + offsetZ],
    });
  }
}

/** Flip north↔south facing in a block state string */
function flipFacingZ(block: string): string {
  if (block.includes('facing=north')) return block.replace('facing=north', 'facing=south');
  if (block.includes('facing=south')) return block.replace('facing=south', 'facing=north');
  return block;
}

/** Paste a source grid mirrored along its Z axis (flips door orientation north↔south) */
function pasteGridFlipZ(
  target: BlockGrid, source: BlockGrid,
  offsetX: number, offsetY: number, offsetZ: number
): void {
  const maxZ = source.length - 1;
  for (let x = 0; x < source.width; x++) {
    for (let y = 0; y < source.height; y++) {
      for (let z = 0; z < source.length; z++) {
        const block = source.get(x, y, z);
        if (block !== 'minecraft:air') {
          const tx = x + offsetX;
          const ty = y + offsetY;
          const tz = (maxZ - z) + offsetZ;
          if (target.inBounds(tx, ty, tz)) {
            target.set(tx, ty, tz, flipFacingZ(block));
          }
        }
      }
    }
  }
  // Copy block entities with adjusted coordinates (Z-flipped)
  for (const be of source.blockEntities) {
    const [bx, by, bz] = be.pos;
    target.blockEntities.push({
      ...be,
      pos: [bx + offsetX, by + offsetY, (maxZ - bz) + offsetZ],
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Fill a circle on a horizontal plane */
function fillCircle(
  grid: BlockGrid, cx: number, y: number, cz: number,
  radius: number, block: string
): void {
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (Math.sqrt(dx * dx + dz * dz) <= radius + 0.5) {
        const x = cx + dx;
        const z = cz + dz;
        if (grid.inBounds(x, y, z)) {
          grid.set(x, y, z, block);
        }
      }
    }
  }
}

/** Structure-specific room constraints applied after initial assignment */
function enforceStructureRooms(result: RoomType[][], structureType: StructureType): void {
  switch (structureType) {
    case 'house':
      // Must include bedroom on floor 1 (index 1)
      if (result.length > 1 && !result[1].includes('bedroom')) {
        result[1][0] = 'bedroom';
      }
      break;
    case 'ship':
      // Must include captains_quarters (replace first study on floor 0)
      if (result.length > 0) {
        const f0 = result[0];
        const studyIdx = f0.indexOf('study');
        if (studyIdx >= 0) {
          f0[studyIdx] = 'captains_quarters';
        } else if (!f0.includes('captains_quarters')) {
          f0[0] = 'captains_quarters';
        }
      }
      break;
    case 'castle':
      // Must include throne on ground floor
      if (result.length > 0 && !result[0].includes('throne')) {
        result[0][0] = 'throne';
      }
      break;
    case 'dungeon':
      // Must include cell rooms on each level
      for (const floorRooms of result) {
        if (!floorRooms.includes('cell')) {
          floorRooms[floorRooms.length - 1] = 'cell';
        }
      }
      break;
    case 'tower':
      // Observatory on top floor (tower uses 1 room/floor, so replace the last)
      if (result.length > 0) {
        result[result.length - 1] = ['observatory'];
      }
      break;
    case 'cathedral':
      // Nave on ground floor, belfry on top
      if (result.length > 0) {
        result[0] = ['nave', 'nave', 'nave', 'nave'];
      }
      if (result.length > 1) {
        result[result.length - 1] = ['belfry', 'belfry', 'belfry', 'belfry'];
      }
      break;
  }
}

/** Resolve room assignments for each floor */
function resolveRooms(floors: number, rooms: RoomType[] | undefined, rng: () => number, structureType: StructureType = 'house'): RoomType[][] {
  if (rooms && rooms.length > 0) {
    const result: RoomType[][] = [];
    let ri = 0;
    for (let f = 0; f < floors; f++) {
      const floorRooms: RoomType[] = [];
      for (let q = 0; q < 4; q++) {
        if (ri < rooms.length) {
          floorRooms.push(rooms[ri++]);
        } else {
          const allTypes = getRoomTypes();
          floorRooms.push(allTypes[Math.floor(rng() * allTypes.length)]);
        }
      }
      result.push(floorRooms);
    }
    enforceStructureRooms(result, structureType);
    return result;
  }

  const result: RoomType[][] = [];
  for (let f = 0; f < floors; f++) {
    const defaultFloor = DEFAULT_FLOOR_ROOMS[f % DEFAULT_FLOOR_ROOMS.length];
    result.push([...defaultFloor]);
  }
  enforceStructureRooms(result, structureType);
  return result;
}
