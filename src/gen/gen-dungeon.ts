/**
 * Dungeon structure generator.
 * Extracted from gen-structures.ts for modularity.
 */

import { BlockGrid } from '../schem/types.js';
import { type RoomType, type RoomBounds } from '../types/index.js';
import { getRoomGenerator } from './rooms.js';
import { 
  exteriorWalls,
  windows,
  staircase,
  weatherWalls,
  addCobwebs,
  addChains,
  accentBand,
 } from './structures.js';
import { type StylePalette } from './styles.js';
import { STORY_H, pick } from './gen-utils.js';

// ─── Dungeon ────────────────────────────────────────────────────────────────

export function generateDungeon(
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
