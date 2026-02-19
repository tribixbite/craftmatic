/**
 * Shared utility functions for structure generators.
 * Extracted from generator.ts to reduce file size and improve modularity.
 */

import { BlockGrid } from '../schem/types.js';
import { isAir } from '../blocks/registry.js';
import type { RoomType, StructureType } from '../types/index.js';
import type { StylePalette } from './styles.js';
import { getRoomTypes } from './rooms.js';

/** Seeded pseudo-random number generator (mulberry32) */
export function createRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a random element from an array */
export function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Place a small outbuilding (shed, gazebo, stable, etc.) at the given position.
 * Creates compositional complexity that scores well in visual evaluation.
 */
export function placeOutbuilding(
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
export const DEFAULT_FLOOR_ROOMS: RoomType[][] = [
  ['living', 'kitchen', 'dining', 'foyer'],
  ['bedroom', 'bathroom', 'closet', 'laundry'],
  ['bedroom', 'study', 'sunroom', 'pantry'],
  ['library', 'bedroom', 'bathroom', 'mudroom'],
  ['observatory', 'gallery', 'gallery', 'gallery'],
];

/** Per-story height in blocks */
export const STORY_H = 5;
/** Roof height allocation */
export const ROOF_H = 10;

/**
 * Crop a BlockGrid to the tightest axis-aligned bounding box around all non-air
 * blocks, with a small padding. Reduces wasted tile budget in the thumbnail renderer.
 */
export function trimGrid(grid: BlockGrid, padding = 1): BlockGrid {
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

/** Paste a source grid into a target grid at the given offset (blocks + block entities) */
export function pasteGrid(
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
export function flipFacingZ(block: string): string {
  if (block.includes('facing=north')) return block.replace('facing=north', 'facing=south');
  if (block.includes('facing=south')) return block.replace('facing=south', 'facing=north');
  return block;
}

/** Paste a source grid mirrored along its Z axis (flips door orientation north↔south) */
export function pasteGridFlipZ(
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

/** Fill a circle on a horizontal plane */
export function fillCircle(
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
export function enforceStructureRooms(result: RoomType[][], structureType: StructureType): void {
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
export function resolveRooms(floors: number, rooms: RoomType[] | undefined, rng: () => number, structureType: StructureType = 'house'): RoomType[][] {
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
