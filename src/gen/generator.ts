/**
 * Main structure generation orchestrator.
 * Coordinates structural elements and room placement to generate
 * complete buildings from parameters. Supports house, tower, castle,
 * dungeon, and ship structure types with distinct layouts.
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

/** Default room assignments per floor when none specified */
const DEFAULT_FLOOR_ROOMS: RoomType[][] = [
  ['living', 'dining', 'kitchen', 'foyer'],
  ['bedroom', 'bedroom', 'bathroom', 'study'],
  ['library', 'library', 'vault', 'armory'],
  ['observatory', 'gallery', 'gallery', 'gallery'],
  ['throne', 'throne', 'lab', 'forge'],
];

/** Per-story height in blocks */
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

  switch (type) {
    case 'tower':
      return generateTower(floors, style, rooms, width, length, rng);
    case 'castle':
      return generateCastle(floors, style, rooms, width, length, rng);
    case 'dungeon':
      return generateDungeon(floors, style, rooms, width, length, rng);
    case 'ship':
      return generateShip(floors, style, rooms, width, length, rng);
    case 'house':
    default:
      return generateHouse(floors, style, rooms, width, length, rng);
  }
}

// ─── House ──────────────────────────────────────────────────────────────────

function generateHouse(
  floors: number, style: StylePalette, rooms: RoomType[] | undefined,
  bwOpt: number | undefined, blOpt: number | undefined, rng: () => number
): BlockGrid {
  const bw = bwOpt ?? 29;
  const bl = blOpt ?? 23;
  const margin = 3;
  const gw = bw + 2 * margin;
  const gl = bl + margin + 4;
  const gh = floors * STORY_H + ROOF_H;

  const bx1 = margin;
  const bx2 = margin + bw - 1;
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

    interiorWall(grid, 'z', xMid, bz1 + 1, bz2 - 1, by + 1, cy - 1, style);
    doorway(grid, xMid, by + 1, zMid - 1, xMid, by + 3, zMid + 1);

    interiorWall(grid, 'x', zMid, bx1 + 1, xMid - 1, by + 1, cy - 1, style);
    interiorWall(grid, 'x', zMid, xMid + 1, bx2 - 1, by + 1, cy - 1, style);
    doorway(grid, bx1 + 4, by + 1, zMid, bx1 + 6, by + 3, zMid);
    doorway(grid, bx2 - 6, by + 1, zMid, bx2 - 4, by + 3, zMid);

    if (story === floors - 1) {
      grid.fill(bx1, cy, bz1, bx2, cy, bz2, style.ceiling);
    }

    wallTorches(grid, bx1, bz1, bx2, bz2, by + 3, style);
  }

  const dx = xMid;
  porch(grid, dx, bz1, 9, STORY_H, style);
  frontDoor(grid, dx, 1, bz1, style);

  const stairX = xMid + 3;
  const stairX2 = xMid + 4;
  for (let story = 0; story < floors - 1; story++) {
    const by = story * STORY_H;
    const nextY = (story + 1) * STORY_H;
    staircase(grid, stairX, stairX2, bz1 + 2, by, nextY, gh);
  }

  const roomAssignment = resolveRooms(floors, rooms, rng);
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

  const roofBase = floors * STORY_H;
  gabledRoof(grid, bx1, bz1, bx2, bz2, roofBase, ROOF_H, style);

  const chimX = Math.floor((bx1 + 1 + xMid - 1) / 2);
  const chimTop = roofBase + ROOF_H - 2;
  chimney(grid, chimX, bz1, STORY_H, chimTop);

  return grid;
}

// ─── Tower ──────────────────────────────────────────────────────────────────

function generateTower(
  floors: number, style: StylePalette, rooms: RoomType[] | undefined,
  bwOpt: number | undefined, _blOpt: number | undefined, rng: () => number
): BlockGrid {
  const radius = bwOpt ? Math.floor(bwOpt / 2) : 6;
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

    // Circular walls
    for (let y = by + 1; y < cy; y++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist >= radius - 0.5 && dist <= radius + 0.5) {
            grid.set(cx + dx, y, cz + dz, style.wall);
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
      for (let dx = -towerRadius; dx <= towerRadius; dx++) {
        for (let dz = -towerRadius; dz <= towerRadius; dz++) {
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist <= towerRadius + 0.5) {
            const tx = tcx + dx;
            const tz = tcz + dz;
            if (!grid.inBounds(tx, y, tz)) continue;

            if (y === 0) {
              grid.set(tx, y, tz, style.foundation);
            } else if (dist >= towerRadius - 0.5) {
              grid.set(tx, y, tz, style.wall);
            } else if (y % STORY_H === 0) {
              grid.set(tx, y, tz, style.floorUpper);
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

  // === Main keep (central building) ===
  const keepW = Math.floor(bw * 0.45);
  const keepL = Math.floor(bl * 0.4);
  const kx1 = xMid - Math.floor(keepW / 2);
  const kx2 = kx1 + keepW - 1;
  const kz1 = zMid - Math.floor(keepL / 2);
  const kz2 = kz1 + keepL - 1;

  for (let story = 0; story < floors; story++) {
    const by = story * STORY_H;
    const cy = by + STORY_H;

    // Keep foundation and floor
    grid.fill(kx1, by, kz1, kx2, by, kz2, story === 0 ? style.floorGround : style.floorUpper);

    // Keep walls
    exteriorWalls(grid, kx1, by + 1, kz1, kx2, cy - 1, kz2, style);

    // Timber columns at corners and mid-points
    const keepCols: [number, number][] = [
      [kx1, kz1], [kx2, kz1], [kx1, kz2], [kx2, kz2],
      [xMid, kz1], [xMid, kz2], [kx1, zMid], [kx2, zMid],
    ];
    timberColumns(grid, keepCols, by, cy, style);
    timberBeams(grid, kx1, by, kz1, kx2, kz2, style);
    timberBeams(grid, kx1, cy, kz1, kx2, kz2, style);

    // Windows
    windows(grid, kx1, kz1, kx2, kz2, by + 2, by + 3, style);

    // Interior: divide keep into rooms
    interiorWall(grid, 'z', xMid, kz1 + 1, kz2 - 1, by + 1, cy - 1, style);
    doorway(grid, xMid, by + 1, zMid - 1, xMid, by + 3, zMid + 1);

    if (keepL > 12) {
      interiorWall(grid, 'x', zMid, kx1 + 1, xMid - 1, by + 1, cy - 1, style);
      interiorWall(grid, 'x', zMid, xMid + 1, kx2 - 1, by + 1, cy - 1, style);
      doorway(grid, kx1 + 3, by + 1, zMid, kx1 + 5, by + 3, zMid);
      doorway(grid, kx2 - 5, by + 1, zMid, kx2 - 3, by + 3, zMid);
    }

    // Ceiling on top floor
    if (story === floors - 1) {
      grid.fill(kx1, cy, kz1, kx2, cy, kz2, style.ceiling);
    }

    wallTorches(grid, kx1, kz1, kx2, kz2, by + 3, style);
  }

  // Keep staircase
  for (let story = 0; story < floors - 1; story++) {
    staircase(grid, xMid + 2, xMid + 3, kz1 + 2, story * STORY_H, (story + 1) * STORY_H, gh);
  }

  // Keep rooms
  const roomAssignment = resolveRooms(floors, rooms, rng);
  for (let story = 0; story < floors; story++) {
    const by = story * STORY_H;
    const fy = by + 1;
    const storyRooms = roomAssignment[story];
    const quadrants: RoomBounds[] = [
      { x1: kx1 + 1, y: fy, z1: kz1 + 1, x2: xMid - 1, z2: zMid - 1, height: STORY_H - 1 },
      { x1: kx1 + 1, y: fy, z1: zMid + 1, x2: xMid - 1, z2: kz2 - 1, height: STORY_H - 1 },
      { x1: xMid + 1, y: fy, z1: zMid + 1, x2: kx2 - 1, z2: kz2 - 1, height: STORY_H - 1 },
      { x1: xMid + 1, y: fy, z1: kz1 + 1, x2: kx2 - 1, z2: zMid - 1, height: STORY_H - 1 },
    ];
    for (let q = 0; q < Math.min(storyRooms.length, quadrants.length); q++) {
      getRoomGenerator(storyRooms[q])(grid, quadrants[q], style);
    }
  }

  // Keep roof (gabled)
  gabledRoof(grid, kx1, kz1, kx2, kz2, floors * STORY_H, ROOF_H, style);

  // Gatehouse entrance
  const gateX = xMid;
  grid.set(gateX - 1, 1, bz1, style.doorLowerS);
  grid.set(gateX - 1, 2, bz1, style.doorUpperS);
  grid.set(gateX, 1, bz1, style.doorLowerS);
  grid.set(gateX, 2, bz1, style.doorUpperS);
  grid.set(gateX + 1, 1, bz1, 'minecraft:air');
  grid.set(gateX + 1, 2, bz1, 'minecraft:air');
  grid.set(gateX + 1, 3, bz1, 'minecraft:air');
  grid.set(gateX - 1, 3, bz1, 'minecraft:air');
  grid.set(gateX, 3, bz1, 'minecraft:air');

  // Courtyard floor
  grid.fill(bx1 + 3, 0, bz1 + 3, bx2 - 3, 0, bz2 - 3, style.floorGround);

  // Torches in courtyard
  for (let x = bx1 + 5; x < bx2 - 3; x += 6) {
    grid.set(x, 1, bz1 + 3, style.lanternFloor);
    grid.set(x, 1, bz2 - 3, style.lanternFloor);
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

    // Corridors — cross shaped
    const corridorW = 3;
    const halfC = Math.floor(corridorW / 2);
    // N-S corridor
    for (let z = bz1 + 1; z <= bz2 - 1; z++) {
      for (let dx = -halfC; dx <= halfC; dx++) {
        for (let y = by + 1; y < cy; y++) {
          grid.set(xMid + dx, y, z, 'minecraft:air');
        }
      }
    }
    // E-W corridor
    for (let x = bx1 + 1; x <= bx2 - 1; x++) {
      for (let dz = -halfC; dz <= halfC; dz++) {
        for (let y = by + 1; y < cy; y++) {
          grid.set(x, y, zMid + dz, 'minecraft:air');
        }
      }
    }

    // Room chambers in each quadrant
    const chamberInset = 2;
    const quadrants: RoomBounds[] = [
      { x1: bx1 + chamberInset, y: by + 1, z1: bz1 + chamberInset,
        x2: xMid - halfC - 1, z2: zMid - halfC - 1, height: STORY_H - 1 },
      { x1: bx1 + chamberInset, y: by + 1, z1: zMid + halfC + 1,
        x2: xMid - halfC - 1, z2: bz2 - chamberInset, height: STORY_H - 1 },
      { x1: xMid + halfC + 1, y: by + 1, z1: zMid + halfC + 1,
        x2: bx2 - chamberInset, z2: bz2 - chamberInset, height: STORY_H - 1 },
      { x1: xMid + halfC + 1, y: by + 1, z1: bz1 + chamberInset,
        x2: bx2 - chamberInset, z2: zMid - halfC - 1, height: STORY_H - 1 },
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

    // Torches along corridors
    for (let z = bz1 + 3; z < bz2; z += 4) {
      grid.set(xMid + halfC + 1, by + 3, z, style.torchW);
      grid.set(xMid - halfC - 1, by + 3, z, style.torchE);
    }
    for (let x = bx1 + 3; x < bx2; x += 4) {
      grid.set(x, by + 3, zMid + halfC + 1, style.torchN);
      grid.set(x, by + 3, zMid - halfC - 1, style.torchS);
    }
  }

  // Staircase from surface to first underground level
  const topStairY = groundY - STORY_H;
  if (topStairY >= 0) {
    staircase(grid, xMid + 1, xMid + 2, bz1 + 3, topStairY, groundY, gh);
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
  const gh = floors * STORY_H + 15;

  const cx = margin + Math.floor(shipW / 2); // center X
  const sz1 = margin; // ship start Z (stern)
  const sz2 = margin + shipLen - 1; // ship end Z (bow)

  const grid = new BlockGrid(gw, gh, gl);

  // Hull shape: tapers at bow and stern, with solid fill below deck
  const hullDepth = 3; // hull extends this many blocks below deck
  const hullBase = hullDepth; // Y level of deck
  for (let z = sz1; z <= sz2; z++) {
    const zFrac = (z - sz1) / (sz2 - sz1); // 0=stern, 1=bow
    let halfWidth: number;
    if (zFrac < 0.15) {
      // Stern taper
      halfWidth = Math.round((zFrac / 0.15) * (shipW / 2));
    } else if (zFrac > 0.85) {
      // Bow taper — sharper point
      halfWidth = Math.round(((1 - zFrac) / 0.15) * (shipW / 2));
    } else {
      halfWidth = Math.floor(shipW / 2);
    }
    halfWidth = Math.max(1, halfWidth);

    // Hull layers from keel to deck
    for (let y = 0; y <= hullBase; y++) {
      // Hull narrows toward the keel (bottom) for a V-shape cross section
      const depthFrac = y / hullBase; // 0=keel, 1=deck
      const layerHalf = Math.max(1, Math.round(halfWidth * (0.5 + 0.5 * depthFrac)));

      for (let dx = -layerHalf; dx <= layerHalf; dx++) {
        const x = cx + dx;
        if (!grid.inBounds(x, y, z)) continue;

        if (Math.abs(dx) >= layerHalf - 1) {
          // Hull shell (outer wall)
          grid.set(x, y, z, style.wall);
        } else if (y === 0) {
          // Keel bottom
          grid.set(x, y, z, style.foundation);
        } else if (y < hullBase) {
          // Below-deck hull interior fill (solid for structural look)
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

  // Main mast (forward)
  const mastZ = sz1 + Math.floor(shipLen * 0.4);
  const mastH = 15;
  for (let y = hullBase; y < hullBase + mastH; y++) {
    if (grid.inBounds(cx, y, mastZ)) {
      grid.set(cx, y, mastZ, style.timber);
    }
  }
  // Yard arm (horizontal beam for sails)
  const yardY = hullBase + Math.floor(mastH * 0.6);
  const yardHalf = Math.floor(shipW / 2) + 1;
  for (let dx = -yardHalf; dx <= yardHalf; dx++) {
    if (grid.inBounds(cx + dx, yardY, mastZ)) {
      grid.set(cx + dx, yardY, mastZ, style.timberX);
    }
  }
  // Main sail (white wool rectangle between yard arm and lower beam)
  const sailTop = yardY - 1;
  const sailBottom = hullBase + 3;
  const sailHalf = yardHalf - 1;
  for (let y = sailBottom; y <= sailTop; y++) {
    // Sail width narrows slightly toward bottom for a billowed look
    const sailFrac = (y - sailBottom) / (sailTop - sailBottom);
    const rowHalf = Math.max(1, Math.round(sailHalf * (0.6 + 0.4 * sailFrac)));
    for (let dx = -rowHalf; dx <= rowHalf; dx++) {
      if (grid.inBounds(cx + dx, y, mastZ)) {
        grid.set(cx + dx, y, mastZ, 'minecraft:white_wool');
      }
    }
  }
  // Restore mast through sail
  for (let y = sailBottom; y <= sailTop; y++) {
    if (grid.inBounds(cx, y, mastZ)) {
      grid.set(cx, y, mastZ, style.timber);
    }
  }

  // Second mast (aft)
  const mast2Z = sz1 + Math.floor(shipLen * 0.7);
  const mast2H = 12;
  for (let y = hullBase; y < hullBase + mast2H; y++) {
    if (grid.inBounds(cx, y, mast2Z)) {
      grid.set(cx, y, mast2Z, style.timber);
    }
  }
  const yard2Y = hullBase + Math.floor(mast2H * 0.6);
  const yard2Half = yardHalf - 1;
  for (let dx = -yard2Half; dx <= yard2Half; dx++) {
    if (grid.inBounds(cx + dx, yard2Y, mast2Z)) {
      grid.set(cx + dx, yard2Y, mast2Z, style.timberX);
    }
  }
  // Aft sail
  const sail2Top = yard2Y - 1;
  const sail2Bottom = hullBase + 3;
  for (let y = sail2Bottom; y <= sail2Top; y++) {
    const sailFrac = (y - sail2Bottom) / (sail2Top - sail2Bottom);
    const rowHalf = Math.max(1, Math.round((yard2Half - 1) * (0.6 + 0.4 * sailFrac)));
    for (let dx = -rowHalf; dx <= rowHalf; dx++) {
      if (grid.inBounds(cx + dx, y, mast2Z)) {
        grid.set(cx + dx, y, mast2Z, 'minecraft:white_wool');
      }
    }
  }
  for (let y = sail2Bottom; y <= sail2Top; y++) {
    if (grid.inBounds(cx, y, mast2Z)) {
      grid.set(cx, y, mast2Z, style.timber);
    }
  }

  // Bowsprit
  const bowZ = sz2 + 1;
  for (let dz = 0; dz < 5; dz++) {
    if (grid.inBounds(cx, hullBase + 2, bowZ + dz)) {
      grid.set(cx, hullBase + 2, bowZ + dz, style.timberZ);
    }
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

  return grid;
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

/** Resolve room assignments for each floor */
function resolveRooms(floors: number, rooms: RoomType[] | undefined, rng: () => number): RoomType[][] {
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
    return result;
  }

  const result: RoomType[][] = [];
  for (let f = 0; f < floors; f++) {
    const defaultFloor = DEFAULT_FLOOR_ROOMS[f % DEFAULT_FLOOR_ROOMS.length];
    result.push([...defaultFloor]);
  }
  return result;
}
