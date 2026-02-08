/**
 * Main structure generation orchestrator.
 * Coordinates structural elements and room placement to generate
 * complete buildings from parameters.
 */

import { BlockGrid } from '../schem/types.js';
import type { GenerationOptions, RoomType, RoomBounds } from '../types/index.js';
import { getStyle } from './styles.js';
import { getRoomGenerator, getRoomTypes } from './rooms.js';
import {
  foundation, floor, exteriorWalls, timberColumns, timberBeams,
  windows, interiorWall, doorway, frontDoor, staircase,
  gabledRoof, chimney, wallTorches, porch,
} from './structures.js';

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

/** Default room assignments per floor when none specified */
const DEFAULT_FLOOR_ROOMS: RoomType[][] = [
  ['living', 'dining', 'kitchen', 'foyer'],
  ['bedroom', 'bedroom', 'bathroom', 'study'],
  ['library', 'library', 'vault', 'armory'],
  ['observatory', 'gallery', 'gallery', 'gallery'],
  ['throne', 'throne', 'lab', 'forge'],
];

/** Per-story height in blocks (1 floor + 4 interior air) */
const STORY_H = 5;
/** Roof height allocation */
const ROOF_H = 10;

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
  const style = getStyle(styleName);

  // Calculate dimensions based on type and floors
  const dims = calculateDimensions(type, floors, width, length);
  const { bw, bl, margin } = dims;
  const gw = bw + 2 * margin; // grid width (with margins for overhangs)
  const gl = bl + margin + 4; // grid length (with front/back margins)
  const gh = floors * STORY_H + ROOF_H; // grid height

  // Building boundaries in absolute grid coords
  const bx1 = margin;
  const bx2 = margin + bw - 1;
  const bz1 = margin;
  const bz2 = margin + bl - 1;
  const xMid = margin + Math.floor(bw / 2);
  const zMid = margin + Math.floor(bl / 2);

  const grid = new BlockGrid(gw, gh, gl);

  // 1. Foundation
  foundation(grid, bx1, bz1, bx2, bz2, style);

  // 2. Per-story shell
  for (let story = 0; story < floors; story++) {
    const by = story * STORY_H;
    const cy = by + STORY_H;

    // Floor surface
    floor(grid, bx1 + 1, by, bz1 + 1, bx2 - 1, bz2 - 1, style, story === 0);

    // Exterior walls
    exteriorWalls(grid, bx1, by + 1, bz1, bx2, cy - 1, bz2, style);

    // Timber frame columns
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

    // Horizontal timber beams
    timberBeams(grid, bx1, by, bz1, bx2, bz2, style);
    timberBeams(grid, bx1, cy, bz1, bx2, bz2, style);

    // Windows
    windows(grid, bx1, bz1, bx2, bz2, by + 2, by + 3, style);

    // Interior dividing walls
    // Central N-S wall at xMid
    interiorWall(grid, 'z', xMid, bz1 + 1, bz2 - 1, by + 1, cy - 1, style);
    // Doorway in central wall
    doorway(grid, xMid, by + 1, zMid - 1, xMid, by + 3, zMid + 1);

    // E-W cross wall at zMid (both wings)
    interiorWall(grid, 'x', zMid, bx1 + 1, xMid - 1, by + 1, cy - 1, style);
    interiorWall(grid, 'x', zMid, xMid + 1, bx2 - 1, by + 1, cy - 1, style);
    // Doorways in cross walls
    doorway(grid, bx1 + 4, by + 1, zMid, bx1 + 6, by + 3, zMid);
    doorway(grid, bx2 - 6, by + 1, zMid, bx2 - 4, by + 3, zMid);

    // Ceiling (top floor only)
    if (story === floors - 1) {
      grid.fill(bx1, cy, bz1, bx2, cy, bz2, style.ceiling);
    }

    // Wall torches
    wallTorches(grid, bx1, bz1, bx2, bz2, by + 3, style);
  }

  // 3. Grand entrance and porch
  const dx = xMid;
  porch(grid, dx, bz1, 9, STORY_H, style);
  frontDoor(grid, dx, 1, bz1, style);

  // 4. Staircase (right wing front, all floors)
  const stairX = xMid + 3;
  const stairX2 = xMid + 4;
  for (let story = 0; story < floors - 1; story++) {
    const by = story * STORY_H;
    const nextY = (story + 1) * STORY_H;
    staircase(grid, stairX, stairX2, bz1 + 2, by, nextY, gh);
  }

  // 5. Room furnishing
  const roomAssignment = resolveRooms(floors, rooms, rng);
  for (let story = 0; story < floors; story++) {
    const by = story * STORY_H;
    const fy = by + 1;
    const storyRooms = roomAssignment[story];

    // Room quadrants: [left-front, left-back, right-back, right-front]
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

  // 6. Roof
  const roofBase = floors * STORY_H;
  gabledRoof(grid, bx1, bz1, bx2, bz2, roofBase, ROOF_H, style);

  // 7. Chimneys
  const chimX = Math.floor((bx1 + 1 + xMid - 1) / 2);
  const chimTop = roofBase + ROOF_H - 2;
  chimney(grid, chimX, bz1, STORY_H, chimTop);

  return grid;
}

/**
 * Calculate building dimensions based on type.
 */
function calculateDimensions(
  type: string, _floors: number, width?: number, length?: number
): { bw: number; bl: number; margin: number } {
  switch (type) {
    case 'tower':
      return { bw: width ?? 11, bl: length ?? 11, margin: 3 };
    case 'castle':
      return { bw: width ?? 45, bl: length ?? 35, margin: 5 };
    case 'dungeon':
      return { bw: width ?? 21, bl: length ?? 21, margin: 3 };
    case 'ship':
      return { bw: width ?? 11, bl: length ?? 35, margin: 5 };
    case 'house':
    default:
      return { bw: width ?? 29, bl: length ?? 23, margin: 3 };
  }
}

/**
 * Resolve room assignments for each floor.
 * Uses provided rooms list or defaults based on floor count.
 */
function resolveRooms(floors: number, rooms: RoomType[] | undefined, rng: () => number): RoomType[][] {
  if (rooms && rooms.length > 0) {
    // Distribute user-specified rooms across floors, 4 per floor
    const result: RoomType[][] = [];
    let ri = 0;
    for (let f = 0; f < floors; f++) {
      const floorRooms: RoomType[] = [];
      for (let q = 0; q < 4; q++) {
        if (ri < rooms.length) {
          floorRooms.push(rooms[ri++]);
        } else {
          // Fill remaining with appropriate defaults
          const allTypes = getRoomTypes();
          floorRooms.push(allTypes[Math.floor(rng() * allTypes.length)]);
        }
      }
      result.push(floorRooms);
    }
    return result;
  }

  // Use default floor assignments
  const result: RoomType[][] = [];
  for (let f = 0; f < floors; f++) {
    const defaultFloor = DEFAULT_FLOOR_ROOMS[f % DEFAULT_FLOOR_ROOMS.length];
    result.push([...defaultFloor]);
  }
  return result;
}
