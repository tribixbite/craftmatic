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
