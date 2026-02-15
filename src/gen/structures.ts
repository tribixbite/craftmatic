/**
 * Structural building primitives — foundations, walls, floors,
 * ceilings, stairs, roofs, windows, doors, chimneys.
 */

import { BlockGrid } from '../schem/types.js';
import type { StylePalette } from './styles.js';

/** Build a foundation layer under the building footprint */
export function foundation(
  grid: BlockGrid, x1: number, z1: number, x2: number, z2: number,
  style: StylePalette
): void {
  grid.fill(x1, 0, z1, x2, 0, z2, style.foundation);
}

/** Build floor surface for a story */
export function floor(
  grid: BlockGrid, x1: number, y: number, z1: number, x2: number, z2: number,
  style: StylePalette, isGround: boolean
): void {
  const material = isGround ? style.floorGround : style.floorUpper;
  grid.fill(x1, y, z1, x2, y, z2, material);
}

/** Build exterior walls for a story (fills perimeter only) */
export function exteriorWalls(
  grid: BlockGrid, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number,
  style: StylePalette
): void {
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      grid.set(x, y, z1, style.wall);
      grid.set(x, y, z2, style.wall);
    }
    for (let z = z1; z <= z2; z++) {
      grid.set(x1, y, z, style.wall);
      grid.set(x2, y, z, style.wall);
    }
  }
}

/** Place timber frame columns at specified positions */
export function timberColumns(
  grid: BlockGrid, positions: [number, number][],
  y1: number, y2: number, style: StylePalette
): void {
  for (let y = y1; y <= y2; y++) {
    for (const [x, z] of positions) {
      grid.set(x, y, z, style.timber);
    }
  }
}

/** Place horizontal timber beams along the building perimeter at a given y */
export function timberBeams(
  grid: BlockGrid, x1: number, y: number, z1: number, x2: number, z2: number,
  style: StylePalette
): void {
  // X-axis beams along front/back
  for (let x = x1; x <= x2; x++) {
    grid.set(x, y, z1, style.timberX);
    grid.set(x, y, z2, style.timberX);
  }
  // Z-axis beams along sides
  for (let z = z1; z <= z2; z++) {
    grid.set(x1, y, z, style.timberZ);
    grid.set(x2, y, z, style.timberZ);
  }
  // Corner posts (vertical logs override horizontal)
  for (const cx of [x1, x2]) {
    for (const cz of [z1, z2]) {
      grid.set(cx, y, cz, style.timber);
    }
  }
}

/** Place windows on the walls of a story */
export function windows(
  grid: BlockGrid, x1: number, z1: number, x2: number, z2: number,
  wy1: number, wy2: number, style: StylePalette, spacing = 3
): void {
  // Front and back walls
  for (let x = x1 + spacing; x < x2; x += spacing) {
    for (let wy = wy1; wy <= wy2; wy++) {
      grid.set(x, wy, z1, style.window);
      grid.set(x, wy, z2, style.window);
    }
  }
  // Side walls
  for (let z = z1 + spacing; z < z2; z += spacing) {
    for (let wy = wy1; wy <= wy2; wy++) {
      grid.set(x1, wy, z, style.window);
      grid.set(x2, wy, z, style.window);
    }
  }
}

/** Build interior dividing walls */
export function interiorWall(
  grid: BlockGrid, wallAxis: 'x' | 'z', fixedPos: number,
  rangeStart: number, rangeEnd: number, y1: number, y2: number,
  style: StylePalette
): void {
  for (let y = y1; y <= y2; y++) {
    if (wallAxis === 'x') {
      // Wall along X axis at z = fixedPos
      for (let x = rangeStart; x <= rangeEnd; x++) {
        grid.set(x, y, fixedPos, style.interiorWall);
      }
    } else {
      // Wall along Z axis at x = fixedPos
      for (let z = rangeStart; z <= rangeEnd; z++) {
        grid.set(fixedPos, y, z, style.interiorWall);
      }
    }
  }
}

/** Cut a doorway opening in a wall */
export function doorway(
  grid: BlockGrid, x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number
): void {
  grid.clear(x1, y1, z1, x2, y2, z2);
}

/** Place a double door on the front wall */
export function frontDoor(
  grid: BlockGrid, dx: number, y: number, wallZ: number, style: StylePalette,
  facing: 'north' | 'south' = 'south'
): void {
  const lower = facing === 'south' ? style.doorLowerS : style.doorLowerN;
  const upper = facing === 'south' ? style.doorUpperS : style.doorUpperN;
  grid.set(dx - 1, y, wallZ, lower);
  grid.set(dx - 1, y + 1, wallZ, upper);
  grid.set(dx, y, wallZ, lower);
  grid.set(dx, y + 1, wallZ, upper);
}

/** Build a staircase between stories */
export function staircase(
  grid: BlockGrid, stairX: number, stairX2: number, startZ: number,
  baseY: number, nextFloorY: number, gridHeight: number
): void {
  const stairBlock = 'minecraft:oak_stairs[facing=south]';
  const supportBlock = 'minecraft:oak_planks';

  // Four stair steps going inward (z increasing)
  for (let i = 0; i < 4; i++) {
    const sz = startZ + i;
    const sy = baseY + 1 + i;
    for (const sx of [stairX, stairX2]) {
      grid.set(sx, sy, sz, stairBlock);
      grid.set(sx, sy - 1, sz, supportBlock);
      // Clear above
      for (let cly = sy + 1; cly < Math.min(sy + 5, gridHeight); cly++) {
        const cur = grid.get(sx, cly, sz);
        if (cur !== 'minecraft:air') {
          grid.set(sx, cly, sz, 'minecraft:air');
        }
      }
    }
  }

  // Landing
  for (let lx = stairX - 1; lx <= stairX2 + 1; lx++) {
    grid.set(lx, nextFloorY, startZ + 4, supportBlock);
    for (let cly = nextFloorY + 1; cly < nextFloorY + 4; cly++) {
      if (grid.inBounds(lx, cly, startZ + 4)) {
        grid.set(lx, cly, startZ + 4, 'minecraft:air');
      }
    }
  }

  // Open stairwell in the floor above
  for (let sx = stairX - 1; sx <= stairX2 + 1; sx++) {
    for (let sz = startZ; sz < startZ + 5; sz++) {
      grid.set(sx, nextFloorY, sz, 'minecraft:air');
    }
  }

  // Iron bar railing around stairwell opening
  for (let sx = stairX - 1; sx <= stairX2 + 1; sx++) {
    grid.set(sx, nextFloorY + 1, startZ + 5, 'minecraft:iron_bars');
  }
  for (let sz = startZ; sz <= startZ + 5; sz++) {
    grid.set(stairX - 2, nextFloorY + 1, sz, 'minecraft:iron_bars');
  }
}

/** Build a peaked gable roof */
export function gabledRoof(
  grid: BlockGrid, x1: number, z1: number, x2: number, z2: number,
  baseY: number, maxHeight: number, style: StylePalette
): void {
  const ridgeZ = z1 + Math.floor((z2 - z1) / 2);
  const maxLayers = Math.min(Math.floor((z2 - z1) / 2), maxHeight - 1);

  for (let layer = 0; layer < maxLayers; layer++) {
    const ry = baseY + 1 + layer;
    if (!grid.inBounds(0, ry, 0)) break;

    const zSouth = z1 + layer;
    const zNorth = z2 - layer;
    if (zSouth >= zNorth) break;

    for (let x = x1 - 1; x <= x2 + 1; x++) {
      // South slope stairs
      if (grid.inBounds(x, ry, zSouth)) {
        grid.set(x, ry, zSouth, style.roofS);
      }
      // North slope stairs
      if (grid.inBounds(x, ry, zNorth)) {
        grid.set(x, ry, zNorth, style.roofN);
      }
      // Fill roof interior between south and north slopes with ceiling material
      // This prevents the hollow/stripe appearance
      for (let z = zSouth + 1; z < zNorth; z++) {
        if (grid.inBounds(x, ry, z)) {
          grid.set(x, ry, z, style.ceiling);
        }
      }
    }
  }

  // Ridge cap
  const ridgeY = baseY + maxLayers;
  if (grid.inBounds(0, ridgeY, ridgeZ)) {
    for (let x = x1 - 1; x <= x2 + 1; x++) {
      if (grid.inBounds(x, ridgeY, ridgeZ)) {
        grid.set(x, ridgeY, ridgeZ, style.roofCap);
      }
    }
  }

  // Gable end walls (overwrite the ceiling fill at the gable faces)
  for (let layer = 0; layer < maxLayers; layer++) {
    const ry = baseY + 1 + layer;
    if (!grid.inBounds(0, ry, 0)) break;
    const zSouth = z1 + layer;
    const zNorth = z2 - layer;
    if (zSouth >= zNorth) break;
    for (let z = zSouth + 1; z < zNorth; z++) {
      grid.set(x1, ry, z, style.wall);
      grid.set(x2, ry, z, style.wall);
    }
  }
}

/**
 * Build a hip roof — all four sides slope inward, no vertical gable end walls.
 * Each layer shrinks both X and Z ranges, forming a pyramid-like top.
 */
export function hipRoof(
  grid: BlockGrid, x1: number, z1: number, x2: number, z2: number,
  baseY: number, maxHeight: number, style: StylePalette
): void {
  const xSpan = x2 - x1;
  const zSpan = z2 - z1;
  const maxLayers = Math.min(Math.floor(Math.min(xSpan, zSpan) / 2), maxHeight - 1);

  for (let layer = 0; layer < maxLayers; layer++) {
    const ry = baseY + 1 + layer;
    if (!grid.inBounds(0, ry, 0)) break;

    const zSouth = z1 + layer;
    const zNorth = z2 - layer;
    const xWest = x1 - 1 + layer;
    const xEast = x2 + 1 - layer;
    if (zSouth >= zNorth || xWest >= xEast) break;

    // South and north slopes (full width at this layer)
    for (let x = xWest; x <= xEast; x++) {
      if (grid.inBounds(x, ry, zSouth)) grid.set(x, ry, zSouth, style.roofS);
      if (grid.inBounds(x, ry, zNorth)) grid.set(x, ry, zNorth, style.roofN);
    }

    // East and west slopes (between south and north, using stair blocks rotated)
    // Use ceiling material for side slopes (stairs only face N/S in palette)
    for (let z = zSouth + 1; z < zNorth; z++) {
      if (grid.inBounds(xWest, ry, z)) grid.set(xWest, ry, z, style.roofCap);
      if (grid.inBounds(xEast, ry, z)) grid.set(xEast, ry, z, style.roofCap);
    }

    // Fill interior between slopes with ceiling material
    for (let x = xWest + 1; x < xEast; x++) {
      for (let z = zSouth + 1; z < zNorth; z++) {
        if (grid.inBounds(x, ry, z)) grid.set(x, ry, z, style.ceiling);
      }
    }
  }

  // Ridge cap along the center (runs along X since Z converges first for typical houses)
  const ridgeY = baseY + maxLayers;
  const ridgeZ = z1 + Math.floor(zSpan / 2);
  const ridgeX1 = x1 - 1 + maxLayers;
  const ridgeX2 = x2 + 1 - maxLayers;
  if (ridgeX1 <= ridgeX2 && grid.inBounds(0, ridgeY, ridgeZ)) {
    for (let x = ridgeX1; x <= ridgeX2; x++) {
      if (grid.inBounds(x, ridgeY, ridgeZ)) grid.set(x, ridgeY, ridgeZ, style.roofCap);
    }
  }
}

/**
 * Build a flat roof — simple slab layer on top with a parapet wall around the edge.
 * Common for modern, desert, and Mediterranean architecture.
 */
export function flatRoof(
  grid: BlockGrid, x1: number, z1: number, x2: number, z2: number,
  baseY: number, _maxHeight: number, style: StylePalette
): void {
  // Flat roof surface (2 layers thick for solidity)
  grid.fill(x1, baseY + 1, z1, x2, baseY + 1, z2, style.ceiling);
  grid.fill(x1, baseY + 2, z1, x2, baseY + 2, z2, style.roofCap);

  // Parapet wall (1 block high around the perimeter)
  const py = baseY + 3;
  for (let x = x1; x <= x2; x++) {
    if (grid.inBounds(x, py, z1)) grid.set(x, py, z1, style.wallAccent);
    if (grid.inBounds(x, py, z2)) grid.set(x, py, z2, style.wallAccent);
  }
  for (let z = z1; z <= z2; z++) {
    if (grid.inBounds(x1, py, z)) grid.set(x1, py, z, style.wallAccent);
    if (grid.inBounds(x2, py, z)) grid.set(x2, py, z, style.wallAccent);
  }
}

/**
 * Build a gambrel roof — "barn roof" with two slopes per side.
 * Lower slope is steep (nearly vertical), upper slope is shallow.
 * Common for colonial, Dutch colonial, and farmhouse styles.
 */
export function gambrelRoof(
  grid: BlockGrid, x1: number, z1: number, x2: number, z2: number,
  baseY: number, maxHeight: number, style: StylePalette
): void {
  const zSpan = z2 - z1;
  const halfZ = Math.floor(zSpan / 2);
  const steepLayers = Math.min(Math.floor(halfZ * 0.4), 3); // Lower steep section
  const shallowLayers = Math.min(halfZ - steepLayers, maxHeight - steepLayers - 1);

  // Lower steep section — advances 1 Z per 2 layers (steep angle)
  let currentLayer = 0;
  for (let i = 0; i < steepLayers; i++) {
    const ry = baseY + 1 + currentLayer;
    if (!grid.inBounds(0, ry, 0)) break;
    const zS = z1 + i;
    const zN = z2 - i;
    if (zS >= zN) break;

    for (let x = x1 - 1; x <= x2 + 1; x++) {
      if (grid.inBounds(x, ry, zS)) grid.set(x, ry, zS, style.roofS);
      if (grid.inBounds(x, ry, zN)) grid.set(x, ry, zN, style.roofN);
      // Fill interior
      for (let z = zS + 1; z < zN; z++) {
        if (grid.inBounds(x, ry, z)) grid.set(x, ry, z, style.ceiling);
      }
    }
    currentLayer++;
  }

  // Upper shallow section — advances 1 Z per layer (normal gable angle)
  const zOffset = steepLayers;
  for (let i = 0; i < shallowLayers; i++) {
    const ry = baseY + 1 + currentLayer;
    if (!grid.inBounds(0, ry, 0)) break;
    const zS = z1 + zOffset + i;
    const zN = z2 - zOffset - i;
    if (zS >= zN) break;

    for (let x = x1 - 1; x <= x2 + 1; x++) {
      if (grid.inBounds(x, ry, zS)) grid.set(x, ry, zS, style.roofS);
      if (grid.inBounds(x, ry, zN)) grid.set(x, ry, zN, style.roofN);
      for (let z = zS + 1; z < zN; z++) {
        if (grid.inBounds(x, ry, z)) grid.set(x, ry, z, style.ceiling);
      }
    }
    currentLayer++;
  }

  // Ridge cap
  const ridgeZ = z1 + Math.floor(zSpan / 2);
  const ridgeY = baseY + 1 + currentLayer;
  if (grid.inBounds(0, ridgeY, ridgeZ)) {
    for (let x = x1 - 1; x <= x2 + 1; x++) {
      if (grid.inBounds(x, ridgeY, ridgeZ)) grid.set(x, ridgeY, ridgeZ, style.roofCap);
    }
  }

  // Gable end walls
  for (let layer = 0; layer < currentLayer; layer++) {
    const ry = baseY + 1 + layer;
    if (!grid.inBounds(0, ry, 0)) break;
    // Determine Z bounds at this layer
    let zS: number, zN: number;
    if (layer < steepLayers) {
      zS = z1 + layer;
      zN = z2 - layer;
    } else {
      const shallow = layer - steepLayers;
      zS = z1 + steepLayers + shallow;
      zN = z2 - steepLayers - shallow;
    }
    if (zS >= zN) break;
    for (let z = zS + 1; z < zN; z++) {
      grid.set(x1, ry, z, style.wall);
      grid.set(x2, ry, z, style.wall);
    }
  }
}

/**
 * Build a mansard roof — steep lower slopes on all four sides, then a flat or
 * low-slope top section. Classic French Second Empire style.
 * The steep lower portion provides usable attic space.
 */
export function mansardRoof(
  grid: BlockGrid, x1: number, z1: number, x2: number, z2: number,
  baseY: number, maxHeight: number, style: StylePalette
): void {
  const xSpan = x2 - x1;
  const zSpan = z2 - z1;
  // Steep lower section: 3-4 layers that each shrink 1 block on all sides
  const steepLayers = Math.min(4, Math.floor(Math.min(xSpan, zSpan) / 3), maxHeight - 2);

  for (let layer = 0; layer < steepLayers; layer++) {
    const ry = baseY + 1 + layer;
    if (!grid.inBounds(0, ry, 0)) break;

    const zS = z1 + layer;
    const zN = z2 - layer;
    const xW = x1 - 1 + layer;
    const xE = x2 + 1 - layer;
    if (zS >= zN || xW >= xE) break;

    // South and north slopes
    for (let x = xW; x <= xE; x++) {
      if (grid.inBounds(x, ry, zS)) grid.set(x, ry, zS, style.roofS);
      if (grid.inBounds(x, ry, zN)) grid.set(x, ry, zN, style.roofN);
    }
    // East and west slopes
    for (let z = zS + 1; z < zN; z++) {
      if (grid.inBounds(xW, ry, z)) grid.set(xW, ry, z, style.roofCap);
      if (grid.inBounds(xE, ry, z)) grid.set(xE, ry, z, style.roofCap);
    }
    // Fill interior
    for (let x = xW + 1; x < xE; x++) {
      for (let z = zS + 1; z < zN; z++) {
        if (grid.inBounds(x, ry, z)) grid.set(x, ry, z, style.ceiling);
      }
    }

    // Dormer windows on the steep section (layer 1 and 2)
    if (layer >= 1 && layer <= 2) {
      const midX = Math.floor((xW + xE) / 2);
      if (grid.inBounds(midX, ry, zS)) grid.set(midX, ry, zS, style.window);
      if (grid.inBounds(midX, ry, zN)) grid.set(midX, ry, zN, style.window);
    }
  }

  // Flat top section
  const topY = baseY + 1 + steepLayers;
  const topZ1 = z1 + steepLayers;
  const topZ2 = z2 - steepLayers;
  const topX1 = x1 - 1 + steepLayers;
  const topX2 = x2 + 1 - steepLayers;
  if (topX1 < topX2 && topZ1 < topZ2 && grid.inBounds(topX1, topY, topZ1)) {
    // Flat roof cap with parapet
    for (let x = topX1; x <= topX2; x++) {
      for (let z = topZ1; z <= topZ2; z++) {
        if (grid.inBounds(x, topY, z)) grid.set(x, topY, z, style.roofCap);
      }
    }
    // Small parapet on the flat section
    const parapetY = topY + 1;
    for (let x = topX1; x <= topX2; x++) {
      if (grid.inBounds(x, parapetY, topZ1)) grid.set(x, parapetY, topZ1, style.wallAccent);
      if (grid.inBounds(x, parapetY, topZ2)) grid.set(x, parapetY, topZ2, style.wallAccent);
    }
    for (let z = topZ1; z <= topZ2; z++) {
      if (grid.inBounds(topX1, parapetY, z)) grid.set(topX1, parapetY, z, style.wallAccent);
      if (grid.inBounds(topX2, parapetY, z)) grid.set(topX2, parapetY, z, style.wallAccent);
    }
  }
}

/** Build a chimney rising from a given position */
export function chimney(
  grid: BlockGrid, x: number, z: number,
  startY: number, topY: number
): void {
  for (let y = startY; y < topY; y++) {
    if (grid.inBounds(x, y, z)) {
      grid.set(x, y, z, 'minecraft:bricks');
    }
  }
  if (grid.inBounds(x, topY, z)) {
    grid.set(x, topY, z, 'minecraft:stone_brick_slab[type=bottom]');
  }
}

/** Place wall torches at lighting positions for a story */
export function wallTorches(
  grid: BlockGrid, x1: number, z1: number, x2: number, z2: number,
  y: number, style: StylePalette, spacing = 6
): void {
  // Front/back walls
  for (let x = x1 + spacing; x < x2; x += spacing) {
    grid.set(x, y, z1 + 1, style.torchS);
    grid.set(x, y, z2 - 1, style.torchN);
  }
  // Side walls
  for (let z = z1 + spacing; z < z2; z += spacing) {
    grid.set(x1 + 1, y, z, style.torchE);
    grid.set(x2 - 1, y, z, style.torchW);
  }
}

/** Build a porch extending from the front of the building */
export function porch(
  grid: BlockGrid, cx: number, wallZ: number, width: number,
  storyH: number, style: StylePalette, direction: 'north' | 'south' = 'north'
): void {
  const halfW = Math.floor(width / 2);
  const dir = direction === 'north' ? -1 : 1;
  const outerZ = wallZ + dir * 2;
  const innerZ = wallZ + dir;

  // Platform
  grid.fill(cx - halfW, 0, Math.min(wallZ, outerZ), cx + halfW, 0, Math.max(wallZ, outerZ), style.foundation);
  grid.fill(cx - halfW + 1, 0, Math.min(wallZ, outerZ), cx + halfW - 1, 0, Math.max(wallZ, outerZ), 'minecraft:polished_deepslate');

  // Columns
  for (let y = 0; y <= storyH; y++) {
    grid.set(cx - halfW + 1, y, innerZ, style.pillar);
    grid.set(cx + halfW - 1, y, innerZ, style.pillar);
    grid.set(cx - halfW + 1, y, wallZ, style.pillar);
    grid.set(cx + halfW - 1, y, wallZ, style.pillar);
  }

  // Porch roof slab
  grid.fill(cx - halfW, storyH, Math.min(wallZ, outerZ), cx + halfW, storyH, Math.max(wallZ, outerZ), style.slabBottom);

  // Entrance steps
  const stairFacing = direction === 'north' ? 'south' : 'north';
  const stepZ = wallZ + dir * 3;
  if (grid.inBounds(cx, 0, stepZ)) {
    grid.set(cx - 1, 0, stepZ, `minecraft:stone_brick_stairs[facing=${stairFacing}]`);
    grid.set(cx, 0, stepZ, `minecraft:stone_brick_stairs[facing=${stairFacing}]`);
    grid.set(cx + 1, 0, stepZ, `minecraft:stone_brick_stairs[facing=${stairFacing}]`);
  }
}

// ─── Terrain / Landscaping Primitives ──────────────────────────────

type TreeType = 'oak' | 'birch' | 'spruce' | 'dark_oak';

/** Place a tree with trunk and spherical leaf canopy */
export function placeTree(
  grid: BlockGrid, x: number, y: number, z: number,
  type: TreeType = 'oak', trunkHeight = 5
): void {
  const log = `minecraft:${type}_log`;
  const leaves = `minecraft:${type}_leaves[persistent=true]`;

  // Trunk
  for (let i = 0; i < trunkHeight; i++) {
    if (grid.inBounds(x, y + i, z)) grid.set(x, y + i, z, log);
  }

  // Leaf canopy (sphere, radius based on tree size)
  const leafR = type === 'dark_oak' ? 3 : 2;
  const canopyBase = y + trunkHeight - 1;
  for (let dx = -leafR; dx <= leafR; dx++) {
    for (let dy = -1; dy <= leafR; dy++) {
      for (let dz = -leafR; dz <= leafR; dz++) {
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist <= leafR + 0.5) {
          const lx = x + dx, ly = canopyBase + dy, lz = z + dz;
          if (grid.inBounds(lx, ly, lz) && grid.get(lx, ly, lz) === 'minecraft:air') {
            grid.set(lx, ly, lz, leaves);
          }
        }
      }
    }
  }
}

/** Place a natural-looking hill/mound of grass and dirt */
export function placeHill(
  grid: BlockGrid, cx: number, cz: number,
  radius: number, height: number, baseY = 0
): void {
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > radius) continue;
      // Height tapers with distance from center (cosine falloff)
      const h = Math.max(1, Math.round(height * Math.cos((dist / radius) * (Math.PI / 2))));
      const x = cx + dx, z = cz + dz;
      for (let y = baseY + 1; y <= baseY + h; y++) {
        if (!grid.inBounds(x, y, z)) continue;
        // Top layer is grass, rest is dirt
        grid.set(x, y, z, y === baseY + h ? 'minecraft:grass_block' : 'minecraft:dirt');
      }
    }
  }
}

/** Place a water pond depression with grass border */
export function placePond(
  grid: BlockGrid, cx: number, cz: number,
  radius: number, baseY = 0
): void {
  for (let dx = -radius - 1; dx <= radius + 1; dx++) {
    for (let dz = -radius - 1; dz <= radius + 1; dz++) {
      const dist = Math.sqrt(dx * dx + dz * dz);
      const x = cx + dx, z = cz + dz;
      if (!grid.inBounds(x, baseY, z)) continue;
      if (dist <= radius) {
        // Water interior
        grid.set(x, baseY, z, 'minecraft:water');
      } else if (dist <= radius + 1.2) {
        // Grass border ring
        grid.set(x, baseY, z, 'minecraft:grass_block');
      }
    }
  }
}

/** Place a flat path between a series of waypoints */
export function placePath(
  grid: BlockGrid, points: [number, number][],
  width: number, material: string, baseY = 0
): void {
  const halfW = Math.floor(width / 2);
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, z0] = points[i];
    const [x1, z1] = points[i + 1];
    const dx = x1 - x0, dz = z1 - z0;
    const steps = Math.max(Math.abs(dx), Math.abs(dz));
    if (steps === 0) continue;
    for (let s = 0; s <= steps; s++) {
      const px = Math.round(x0 + (dx * s) / steps);
      const pz = Math.round(z0 + (dz * s) / steps);
      // Place path strip perpendicular to dominant direction
      if (Math.abs(dx) >= Math.abs(dz)) {
        // Path runs along X, widen along Z
        for (let w = -halfW; w <= halfW; w++) {
          if (grid.inBounds(px, baseY, pz + w)) grid.set(px, baseY, pz + w, material);
        }
      } else {
        // Path runs along Z, widen along X
        for (let w = -halfW; w <= halfW; w++) {
          if (grid.inBounds(px + w, baseY, pz)) grid.set(px + w, baseY, pz, material);
        }
      }
    }
  }
}

/** Place a garden with flower beds and potted plants */
export function placeGarden(
  grid: BlockGrid, x1: number, z1: number, x2: number, z2: number,
  baseY = 0, rng: () => number = Math.random
): void {
  const flowers = [
    'minecraft:potted_poppy', 'minecraft:potted_dandelion',
    'minecraft:potted_blue_orchid', 'minecraft:potted_allium',
    'minecraft:potted_azure_bluet', 'minecraft:potted_red_tulip',
    'minecraft:potted_oxeye_daisy', 'minecraft:potted_cornflower',
    'minecraft:potted_lily_of_the_valley', 'minecraft:potted_wither_rose',
  ];
  const groundCovers = [
    'minecraft:grass_block', 'minecraft:moss_block',
    'minecraft:podzol', 'minecraft:coarse_dirt',
  ];

  const xMin = Math.min(x1, x2), xMax = Math.max(x1, x2);
  const zMin = Math.min(z1, z2), zMax = Math.max(z1, z2);

  for (let x = xMin; x <= xMax; x++) {
    for (let z = zMin; z <= zMax; z++) {
      if (!grid.inBounds(x, baseY, z)) continue;
      // Ground layer
      const gi = Math.floor(rng() * groundCovers.length);
      grid.set(x, baseY, z, groundCovers[gi]);
      // ~30% chance of a potted flower on top
      if (rng() < 0.3 && grid.inBounds(x, baseY + 1, z)) {
        const fi = Math.floor(rng() * flowers.length);
        grid.set(x, baseY + 1, z, flowers[fi]);
      }
    }
  }
}

// ─── Exterior House Features ────────────────────────────────────────

/** Add a fenced backyard with garden, bench, and optional tree (low-Z side of house) */
export function addBackyard(
  grid: BlockGrid, bx1: number, bx2: number, bz1: number,
  style: StylePalette, rng: () => number
): void {
  const yardZ1 = Math.max(0, bz1 - 8);
  const yardZ2 = bz1 - 1;
  if (yardZ2 - yardZ1 < 3) return; // not enough space

  // Fence perimeter (U-shape behind house)
  for (let x = bx1; x <= bx2; x++) {
    if (grid.inBounds(x, 1, yardZ1)) grid.set(x, 1, yardZ1, style.fence);
  }
  for (let z = yardZ1; z <= yardZ2; z++) {
    if (grid.inBounds(bx1, 1, z)) grid.set(bx1, 1, z, style.fence);
    if (grid.inBounds(bx2, 1, z)) grid.set(bx2, 1, z, style.fence);
  }

  // Fence gate at center back
  const gateCx = Math.floor((bx1 + bx2) / 2);
  if (grid.inBounds(gateCx, 1, yardZ1))
    grid.set(gateCx, 1, yardZ1, `minecraft:oak_fence_gate[facing=south,open=false]`);

  // Garden flower bed
  const gardenX1 = bx1 + 2;
  const gardenX2 = Math.min(bx1 + 6, bx2 - 2);
  const gardenZ = yardZ1 + 2;
  if (gardenX2 > gardenX1 && grid.inBounds(gardenX2, 0, gardenZ + 2))
    placeGarden(grid, gardenX1, gardenZ, gardenX2, gardenZ + 2, 0, rng);

  // Bench (stair blocks facing garden)
  const benchX = Math.floor((bx1 + bx2) / 2);
  const benchZ = yardZ2 - 1;
  if (grid.inBounds(benchX, 1, benchZ)) {
    grid.set(benchX, 1, benchZ, `minecraft:oak_stairs[facing=north]`);
    if (grid.inBounds(benchX + 1, 1, benchZ))
      grid.set(benchX + 1, 1, benchZ, `minecraft:oak_stairs[facing=north]`);
  }

  // Tree if space allows
  const treeX = bx2 - 2;
  const treeZ = yardZ1 + 2;
  if (grid.inBounds(treeX, 0, treeZ) && treeX > gardenX2 + 1)
    placeTree(grid, treeX, 1, treeZ, 'birch', 4);
}

/** Add a stone brick driveway extending from the front door */
export function addDriveway(
  grid: BlockGrid, doorX: number, bz2: number, porchDepth: number
): void {
  const driveStart = bz2 + porchDepth + 1;
  const driveEnd = driveStart + 6;
  const halfW = 1; // 3-wide path

  for (let z = driveStart; z <= driveEnd; z++) {
    for (let dx = -halfW; dx <= halfW; dx++) {
      if (grid.inBounds(doorX + dx, 0, z))
        grid.set(doorX + dx, 0, z, 'minecraft:stone_bricks');
    }
    // Slab borders
    if (grid.inBounds(doorX - halfW - 1, 0, z))
      grid.set(doorX - halfW - 1, 0, z, 'minecraft:stone_brick_slab[type=bottom]');
    if (grid.inBounds(doorX + halfW + 1, 0, z))
      grid.set(doorX + halfW + 1, 0, z, 'minecraft:stone_brick_slab[type=bottom]');
  }
}

/** Add a property fence around the full perimeter with gates at front and back */
export function addPropertyFence(
  grid: BlockGrid, bx1: number, bz1: number, bx2: number, bz2: number,
  doorX: number, style: StylePalette
): void {
  // Expand fence 2 blocks out from building footprint
  const fx1 = Math.max(0, bx1 - 2);
  const fz1 = Math.max(0, bz1 - 10); // back yard side
  const fx2 = Math.min(grid.width - 1, bx2 + 2);
  const fz2 = Math.min(grid.length - 1, bz2 + 8); // front yard side

  // North and south fence runs
  for (let x = fx1; x <= fx2; x++) {
    if (grid.inBounds(x, 1, fz1)) grid.set(x, 1, fz1, style.fence);
    if (grid.inBounds(x, 1, fz2)) grid.set(x, 1, fz2, style.fence);
  }
  // East and west fence runs
  for (let z = fz1; z <= fz2; z++) {
    if (grid.inBounds(fx1, 1, z)) grid.set(fx1, 1, z, style.fence);
    if (grid.inBounds(fx2, 1, z)) grid.set(fx2, 1, z, style.fence);
  }

  // Corner posts (double height)
  for (const [px, pz] of [[fx1, fz1], [fx1, fz2], [fx2, fz1], [fx2, fz2]] as [number, number][]) {
    if (grid.inBounds(px, 2, pz)) grid.set(px, 2, pz, style.fence);
  }

  // Interval posts every 4 blocks
  for (let x = fx1 + 4; x < fx2; x += 4) {
    if (grid.inBounds(x, 2, fz1)) grid.set(x, 2, fz1, style.fence);
    if (grid.inBounds(x, 2, fz2)) grid.set(x, 2, fz2, style.fence);
  }
  for (let z = fz1 + 4; z < fz2; z += 4) {
    if (grid.inBounds(fx1, 2, z)) grid.set(fx1, 2, z, style.fence);
    if (grid.inBounds(fx2, 2, z)) grid.set(fx2, 2, z, style.fence);
  }

  // Front gate (at driveway)
  if (grid.inBounds(doorX, 1, fz2))
    grid.set(doorX, 1, fz2, `minecraft:oak_fence_gate[facing=north,open=false]`);

  // Back gate
  const backGateX = Math.floor((bx1 + bx2) / 2);
  if (grid.inBounds(backGateX, 1, fz1))
    grid.set(backGateX, 1, fz1, `minecraft:oak_fence_gate[facing=south,open=false]`);
}
