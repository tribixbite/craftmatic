/**
 * Main structure generation orchestrator.
 * Coordinates structural elements and room placement to generate
 * complete buildings from parameters. Supports house, tower, castle,
 * dungeon, and ship structure types with distinct layouts.
 */

import { BlockGrid } from '../schem/types.js';
import type { GenerationOptions, RoomType, RoomBounds, StructureType } from '../types/index.js';
import { getStyle } from './styles.js';
import { getRoomGenerator, getRoomTypes } from './rooms.js';
import {
  foundation, floor, exteriorWalls, timberColumns, timberBeams,
  windows, interiorWall, doorway, frontDoor, staircase,
  gabledRoof, chimney, wallTorches, porch,
  placeTree, placeGarden,
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
    case 'cathedral':
      return generateCathedral(floors, style, rooms, width, length, rng);
    case 'bridge':
      return generateBridge(floors, style, rooms, width, length, rng);
    case 'windmill':
      return generateWindmill(floors, style, rooms, width, length, rng);
    case 'marketplace':
      return generateMarketplace(floors, style, rooms, width, length, rng);
    case 'village':
      return generateVillage(floors, style, rooms, width, length, rng);
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
  const porchDepth = 4;
  const gw = bw + 2 * margin;
  const gl = bl + 2 * margin + porchDepth;
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
  porch(grid, dx, bz2, 9, STORY_H, style, 'south');
  frontDoor(grid, dx, 1, bz2, style, 'north');

  // Exterior lanterns flanking the front door
  if (grid.inBounds(dx - 2, 1, bz2 + 1))
    grid.set(dx - 2, 1, bz2 + 1, style.lanternFloor);
  if (grid.inBounds(dx + 2, 1, bz2 + 1))
    grid.set(dx + 2, 1, bz2 + 1, style.lanternFloor);

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
  const roomAssignment = resolveRooms(floors, rooms, rng, 'castle');
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

    // Torches along corridors (dense — every 4 blocks)
    for (let z = bz1 + 3; z < bz2 - 2; z += 4) {
      grid.set(xMid + halfC + 1, by + 3, z, style.torchW);
      grid.set(xMid - halfC - 1, by + 3, z, style.torchE);
    }
    for (let x = bx1 + 3; x < bx2 - 2; x += 4) {
      grid.set(x, by + 3, zMid + halfC + 1, style.torchN);
      grid.set(x, by + 3, zMid - halfC - 1, style.torchS);
    }

    // Corridor atmosphere: cobwebs in upper corners
    for (let z = bz1 + 2; z < bz2 - 1; z += 3) {
      if (grid.inBounds(xMid + halfC, cy - 1, z))
        grid.set(xMid + halfC, cy - 1, z, 'minecraft:cobweb');
      if (grid.inBounds(xMid - halfC, cy - 1, z))
        grid.set(xMid - halfC, cy - 1, z, 'minecraft:cobweb');
    }
    for (let x = bx1 + 2; x < bx2 - 1; x += 3) {
      if (grid.inBounds(x, cy - 1, zMid + halfC))
        grid.set(x, cy - 1, zMid + halfC, 'minecraft:cobweb');
      if (grid.inBounds(x, cy - 1, zMid - halfC))
        grid.set(x, cy - 1, zMid - halfC, 'minecraft:cobweb');
    }

    // Chains hanging from ceiling at corridor intersections
    for (let y = by + 2; y < cy; y++) {
      if (grid.inBounds(xMid + halfC, y, zMid))
        grid.set(xMid + halfC, y, zMid, 'minecraft:chain');
      if (grid.inBounds(xMid - halfC, y, zMid))
        grid.set(xMid - halfC, y, zMid, 'minecraft:chain');
    }

    // Cracked stone floor patches in corridors
    for (let z = bz1 + 3; z < bz2 - 2; z += 5) {
      if (grid.inBounds(xMid, by, z))
        grid.set(xMid, by, z, 'minecraft:cracked_stone_bricks');
      if (grid.inBounds(xMid - 1, by, z + 1))
        grid.set(xMid - 1, by, z + 1, 'minecraft:cracked_stone_bricks');
    }
    for (let x = bx1 + 3; x < bx2 - 2; x += 5) {
      if (grid.inBounds(x, by, zMid))
        grid.set(x, by, zMid, 'minecraft:cracked_stone_bricks');
    }

    // Water puddles in corridors
    for (let z = bz1 + 7; z < bz2 - 6; z += 9) {
      if (grid.inBounds(xMid, by + 1, z))
        grid.set(xMid, by + 1, z, 'minecraft:water_cauldron[level=1]');
    }
    if (grid.inBounds(bx1 + 5, by + 1, zMid))
      grid.set(bx1 + 5, by + 1, zMid, 'minecraft:water_cauldron[level=1]');

    // Iron bar cell doors along N-S corridor walls
    for (let z = bz1 + 5; z < bz2 - 4; z += 7) {
      for (const side of [halfC + 1, -(halfC + 1)]) {
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
  const gh = floors * STORY_H + 25;

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

  // ── Main mast (midship, tallest) ──
  const mastZ = sz1 + Math.floor(shipLen * 0.45);
  const mastH = 20;
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

  // Upper yard arm (80% height)
  const yardY = hullBase + Math.floor(mastH * 0.8);
  for (let dx = -yardHalf; dx <= yardHalf; dx++) {
    if (grid.inBounds(cx + dx, yardY, mastZ))
      grid.set(cx + dx, yardY, mastZ, style.timberX);
  }

  // Lower yard arm (40% height)
  const lowerYardY = hullBase + Math.floor(mastH * 0.4);
  for (let dx = -yardHalf; dx <= yardHalf; dx++) {
    if (grid.inBounds(cx + dx, lowerYardY, mastZ))
      grid.set(cx + dx, lowerYardY, mastZ, style.timberX);
  }

  // Upper main sail (between upper and lower yard arms, 2 blocks deep)
  for (let y = lowerYardY + 1; y < yardY; y++) {
    const frac = (y - lowerYardY - 1) / Math.max(1, yardY - lowerYardY - 2);
    const rowHalf = Math.max(1, Math.round(yardHalf * (0.8 + 0.2 * frac)));
    for (let dx = -rowHalf; dx <= rowHalf; dx++) {
      if (grid.inBounds(cx + dx, y, mastZ))
        grid.set(cx + dx, y, mastZ, 'minecraft:white_wool');
      if (grid.inBounds(cx + dx, y, mastZ + 1))
        grid.set(cx + dx, y, mastZ + 1, 'minecraft:white_wool');
    }
  }

  // Lower main sail (lower yard to just above deck, 2 blocks deep)
  for (let y = hullBase + 2; y < lowerYardY; y++) {
    const frac = (y - hullBase - 2) / Math.max(1, lowerYardY - hullBase - 3);
    const rowHalf = Math.max(1, Math.round(yardHalf * (0.8 + 0.2 * frac)));
    for (let dx = -rowHalf; dx <= rowHalf; dx++) {
      if (grid.inBounds(cx + dx, y, mastZ))
        grid.set(cx + dx, y, mastZ, 'minecraft:white_wool');
      if (grid.inBounds(cx + dx, y, mastZ + 1))
        grid.set(cx + dx, y, mastZ + 1, 'minecraft:white_wool');
    }
  }

  // Restore mast through sails
  for (let y = hullBase + 2; y < yardY; y++) {
    if (grid.inBounds(cx, y, mastZ)) grid.set(cx, y, mastZ, style.timber);
  }

  // ── Foremast (near bow, shorter) ──
  const foremastZ = sz1 + Math.floor(shipLen * 0.7);
  const foremastH = 16;
  for (let y = hullBase; y < hullBase + foremastH; y++) {
    if (grid.inBounds(cx, y, foremastZ)) grid.set(cx, y, foremastZ, style.timber);
  }
  const foreYardY = hullBase + Math.floor(foremastH * 0.75);
  const foreYardHalf = yardHalf - 1;
  for (let dx = -foreYardHalf; dx <= foreYardHalf; dx++) {
    if (grid.inBounds(cx + dx, foreYardY, foremastZ))
      grid.set(cx + dx, foreYardY, foremastZ, style.timberX);
  }
  // Fore sail (2 blocks deep)
  for (let y = hullBase + 2; y < foreYardY; y++) {
    const frac = (y - hullBase - 2) / Math.max(1, foreYardY - hullBase - 3);
    const rowHalf = Math.max(1, Math.round(foreYardHalf * (0.8 + 0.2 * frac)));
    for (let dx = -rowHalf; dx <= rowHalf; dx++) {
      if (grid.inBounds(cx + dx, y, foremastZ))
        grid.set(cx + dx, y, foremastZ, 'minecraft:white_wool');
      if (grid.inBounds(cx + dx, y, foremastZ + 1))
        grid.set(cx + dx, y, foremastZ + 1, 'minecraft:white_wool');
    }
  }
  for (let y = hullBase + 2; y < foreYardY; y++) {
    if (grid.inBounds(cx, y, foremastZ)) grid.set(cx, y, foremastZ, style.timber);
  }

  // ── Mizzen mast (near stern, shortest) ──
  const mizzenZ = sz1 + Math.floor(shipLen * 0.18);
  const mizzenH = 13;
  for (let y = hullBase; y < hullBase + mizzenH; y++) {
    if (grid.inBounds(cx, y, mizzenZ)) grid.set(cx, y, mizzenZ, style.timber);
  }
  const mizYardY = hullBase + Math.floor(mizzenH * 0.75);
  const mizYardHalf = yardHalf - 2;
  for (let dx = -mizYardHalf; dx <= mizYardHalf; dx++) {
    if (grid.inBounds(cx + dx, mizYardY, mizzenZ))
      grid.set(cx + dx, mizYardY, mizzenZ, style.timberX);
  }
  // Mizzen sail
  for (let y = hullBase + 2; y < mizYardY; y++) {
    const frac = (y - hullBase - 2) / Math.max(1, mizYardY - hullBase - 3);
    const rowHalf = Math.max(1, Math.round(mizYardHalf * (0.8 + 0.2 * frac)));
    for (let dx = -rowHalf; dx <= rowHalf; dx++) {
      if (grid.inBounds(cx + dx, y, mizzenZ))
        grid.set(cx + dx, y, mizzenZ, 'minecraft:white_wool');
    }
  }
  for (let y = hullBase + 2; y < mizYardY; y++) {
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

  // Bow decoration (carved pumpkin figurehead)
  if (grid.inBounds(cx, hullBase + 1, sz2))
    grid.set(cx, hullBase + 1, sz2, 'minecraft:carved_pumpkin[facing=south]');

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

  // Bell tower (reusing circular tower logic, at front-left corner)
  const towerR = 4;
  const towerCX = bx1 - 1;
  const towerCZ = bz1 - 1;
  const towerH = mainH + 12;
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

  // Parabolic arch underneath
  const midZ = Math.floor((bz1 + bz2) / 2);
  const halfSpan = (bz2 - bz1) / 2;
  for (let z = bz1; z <= bz2; z++) {
    const t = (z - midZ) / halfSpan; // -1 to 1
    const archTop = deckY - 1 - Math.round(archH * (1 - t * t)); // parabola
    // Arch ribs at edges
    for (const x of [bx1, bx2]) {
      for (let y = Math.max(0, archTop); y <= deckY - 1; y++) {
        if (grid.inBounds(x, y, z)) grid.set(x, y, z, style.wall);
      }
    }
    // Arch bottom face
    if (archTop >= 0 && grid.inBounds(cx, archTop, z)) {
      for (let x = bx1; x <= bx2; x++) {
        if (grid.inBounds(x, archTop, z)) grid.set(x, archTop, z, style.wall);
      }
    }
  }

  // Fence railings along bridge deck
  for (let z = bz1; z <= bz2; z++) {
    grid.set(bx1, deckY + 1, z, style.fence);
    grid.set(bx2, deckY + 1, z, style.fence);
  }

  // Lamp posts every 4 blocks on railings — fence post topped with lantern
  for (let z = bz1 + 2; z <= bz2 - 2; z += 4) {
    grid.set(bx1, deckY + 2, z, style.fence);
    grid.set(bx1, deckY + 3, z, style.lanternFloor);
    grid.set(bx2, deckY + 2, z, style.fence);
    grid.set(bx2, deckY + 3, z, style.lanternFloor);
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

  // Path on deck (accent center strip)
  for (let z = bz1; z <= bz2; z++) {
    grid.set(cx, deckY, z, 'minecraft:polished_deepslate');
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

  // Building placement grid — varied house sizes
  const buildingSpots: { x: number; z: number; w: number; l: number; type: 'house' | 'tower' | 'marketplace' }[] = [];

  // Central marketplace
  buildingSpots.push({ x: cx - 12, z: cz - 10, w: 20, l: 16, type: 'marketplace' });

  // Houses with varied dimensions (width 13-18, length 11-16, some 2-story)
  const housePositions: [number, number][] = [
    [margin + 5, margin + 5],
    [margin + gridSize - 30, margin + 5],
    [margin + 5, margin + gridSize - 28],
    [margin + gridSize - 30, margin + gridSize - 28],
  ];
  const numHouses = 3 + Math.floor(rng() * 2); // 3-4 houses
  for (let i = 0; i < Math.min(numHouses, housePositions.length); i++) {
    const hw = 13 + Math.floor(rng() * 6);  // 13-18
    const hl = 11 + Math.floor(rng() * 6);  // 11-16
    buildingSpots.push({ x: housePositions[i][0], z: housePositions[i][1], w: hw, l: hl, type: 'house' });
  }

  // One tower
  buildingSpots.push({ x: cx + 15, z: cz - 5, w: 10, l: 10, type: 'tower' });

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
    pasteGrid(grid, subGrid, spot.x, 0, spot.z);
  }

  // ── Upgraded paths — stone_bricks instead of cobblestone ──
  const wellX = cx;
  const wellZ = cz;
  for (const spot of buildingSpots) {
    const sx = spot.x + Math.floor(spot.w / 2);
    const sz = spot.z + Math.floor(spot.l / 2);
    // Horizontal path segment
    const startX = Math.min(sx, wellX);
    const endX = Math.max(sx, wellX);
    for (let x = startX; x <= endX; x++) {
      for (let dz = -1; dz <= 0; dz++) {
        if (grid.inBounds(x, 0, sz + dz))
          grid.set(x, 0, sz + dz, 'minecraft:stone_bricks');
      }
    }
    // Vertical path segment
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

/** Paste a source grid into a target grid at the given offset */
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
