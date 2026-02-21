/**
 * Castle structure generator.
 * Extracted from gen-structures.ts for modularity.
 */

import { BlockGrid } from '../schem/types.js';
import { type RoomType, type RoomBounds } from '../types/index.js';
import { getRoomGenerator } from './rooms.js';
import { 
  foundation,
  interiorWall,
  doorway,
  staircase,
  wallTorches,
  placeTree,
  weatherWalls,
 } from './structures.js';
import { chandelier } from './furniture.js';
import { type StylePalette } from './styles.js';
import { STORY_H, ROOF_H, resolveRooms } from './gen-utils.js';

// ─── Castle ─────────────────────────────────────────────────────────────────

export function generateCastle(
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
      if (grid.inBounds(x, y, bz1 - 1))
        grid.set(x, y, bz1 - 1, style.wallAccent);
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
  const keepFloors = Math.max(floors, 2);

  for (let story = 0; story < keepFloors; story++) {
    const by = story * STORY_H;
    const cy = by + STORY_H;

    grid.fill(kx1, by, kz1, kx2, by, kz2, story === 0 ? style.foundation : style.floorUpper);

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

    const keepPillars: [number, number][] = [
      [kx1, kz1], [kx2, kz1], [kx1, kz2], [kx2, kz2],
      [xMid, kz1], [xMid, kz2], [kx1, zMid], [kx2, zMid],
    ];
    for (const [px, pz] of keepPillars) {
      for (let y = by; y <= cy; y++) {
        if (grid.inBounds(px, y, pz)) grid.set(px, y, pz, style.wallAccent);
      }
    }

    for (let x = kx1 + 4; x <= kx2 - 4; x += 4) {
      if (grid.inBounds(x, by + 3, kz1)) grid.set(x, by + 3, kz1, 'minecraft:air');
      if (grid.inBounds(x, by + 3, kz2)) grid.set(x, by + 3, kz2, 'minecraft:air');
    }
    for (let z = kz1 + 4; z <= kz2 - 4; z += 4) {
      if (grid.inBounds(kx1, by + 3, z)) grid.set(kx1, by + 3, z, 'minecraft:air');
      if (grid.inBounds(kx2, by + 3, z)) grid.set(kx2, by + 3, z, 'minecraft:air');
    }

    if (story === 0) {
      const colSpacing = Math.max(4, Math.floor(keepW / 4));
      for (let x = kx1 + colSpacing; x < kx2 - 2; x += colSpacing) {
        for (const pz of [kz1 + 3, kz2 - 3]) {
          for (let y = by; y <= cy; y++) {
            if (grid.inBounds(x, y, pz)) grid.set(x, y, pz, style.wallAccent);
          }
        }
      }

      const daisZ1 = kz2 - 5;
      grid.fill(kx1 + 3, by, daisZ1, kx2 - 3, by + 1, kz2 - 2, style.wallAccent);
      grid.set(xMid, by + 2, kz2 - 3, style.chairN);
      for (const ddx of [-2, -1, 1, 2]) {
        if (grid.inBounds(xMid + ddx, by + 2, kz2 - 3))
          grid.set(xMid + ddx, by + 2, kz2 - 3, 'minecraft:gold_block');
      }
      for (let ddx = -3; ddx <= 3; ddx++) {
        if (grid.inBounds(xMid + ddx, by + 3, kz2 - 2))
          grid.set(xMid + ddx, by + 3, kz2 - 2, style.bannerN);
        if (grid.inBounds(xMid + ddx, by + 4, kz2 - 2))
          grid.set(xMid + ddx, by + 4, kz2 - 2, style.bannerN);
      }

      for (let z = kz1 + 3; z < daisZ1; z++) {
        for (let ddx = -1; ddx <= 1; ddx++) {
          if (grid.inBounds(xMid + ddx, by, z))
            grid.set(xMid + ddx, by, z, 'minecraft:red_carpet');
        }
      }

      for (let z = kz1 + 4; z < kz2 - 4; z += Math.floor(keepL / 3)) {
        chandelier(grid, xMid, cy - 1, z, style, 2);
      }

      for (let ddx = -2; ddx <= 2; ddx++) {
        for (let dy = by + 1; dy <= by + 4; dy++) {
          if (grid.inBounds(xMid + ddx, dy, kz1))
            grid.set(xMid + ddx, dy, kz1, 'minecraft:air');
          if (grid.inBounds(xMid + ddx, dy, kz1 + 1))
            grid.set(xMid + ddx, dy, kz1 + 1, 'minecraft:air');
        }
      }
      for (let ddx = -2; ddx <= 2; ddx++) {
        if (grid.inBounds(xMid + ddx, by + 4, kz1))
          grid.set(xMid + ddx, by + 4, kz1, style.wallAccent);
      }
    } else {
      const divZ = zMid + (story % 2 === 0 ? -2 : 2);
      interiorWall(grid, 'x', divZ, kx1 + 2, kx2 - 2, by + 1, cy - 1, style);
      doorway(grid, xMid - 1, by + 1, divZ, xMid + 1, by + 3, divZ);
    }

    if (story === keepFloors - 1) {
      grid.fill(kx1, cy, kz1, kx2, cy, kz2, style.ceiling);
    }

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
        if ((x + z) % 2 === 0 && grid.inBounds(x, keepTopY + 2, z)) {
          grid.set(x, keepTopY + 2, z, style.wall);
        }
      }
    }
  }

  // Keep staircase
  for (let story = 0; story < keepFloors - 1; story++) {
    staircase(grid, kx2 - 4, kx2 - 3, kz1 + 2, story * STORY_H, (story + 1) * STORY_H, gh);
  }

  // Keep rooms
  const roomAssignment = resolveRooms(keepFloors, rooms, rng, 'castle');
  for (let story = 1; story < keepFloors; story++) {
    const by = story * STORY_H;
    const fy = by + 1;
    const storyRooms = roomAssignment[story];
    const divZ = zMid + (story % 2 === 0 ? -2 : 2);
    const chambers: RoomBounds[] = [
      { x1: kx1 + 2, y: fy, z1: kz1 + 2, x2: kx2 - 2, z2: divZ - 1, height: STORY_H - 1 },
      { x1: kx1 + 2, y: fy, z1: divZ + 1, x2: kx2 - 2, z2: kz2 - 2, height: STORY_H - 1 },
    ];
    for (let h = 0; h < Math.min(storyRooms.length, chambers.length); h++) {
      getRoomGenerator(storyRooms[h])(grid, chambers[h], style);
    }
  }

  // Gatehouse entrance
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

  // Courtyard path
  for (let z = bz1 + 3; z <= bz2 - 3; z++) {
    grid.set(xMid - 1, 0, z, 'minecraft:polished_deepslate');
    grid.set(xMid, 0, z, 'minecraft:polished_deepslate');
    grid.set(xMid + 1, 0, z, 'minecraft:polished_deepslate');
  }
  for (let x = bx1 + 3; x <= bx2 - 3; x++) {
    grid.set(x, 0, zMid, 'minecraft:polished_deepslate');
  }

  // Well
  const wellX = xMid;
  const wellZ = bz2 - 6;
  grid.fill(wellX - 1, 0, wellZ - 1, wellX + 1, 0, wellZ + 1, 'minecraft:stone_bricks');
  grid.set(wellX, 0, wellZ, 'minecraft:water_cauldron[level=3]');
  for (const [wx, wz] of [[wellX - 1, wellZ - 1], [wellX + 1, wellZ - 1],
                            [wellX - 1, wellZ + 1], [wellX + 1, wellZ + 1]]) {
    grid.set(wx, 1, wz, style.fence);
    grid.set(wx, 2, wz, style.fence);
  }
  grid.fill(wellX - 1, 3, wellZ - 1, wellX + 1, 3, wellZ + 1, style.slabBottom);
  grid.set(wellX, 2, wellZ, 'minecraft:chain');
  grid.set(wellX, 1, wellZ, style.lanternFloor);

  // Training grounds
  const trainX = bx1 + 6;
  const trainZ = bz1 + 6;
  grid.set(trainX, 1, trainZ, 'minecraft:hay_block');
  grid.set(trainX, 2, trainZ, 'minecraft:target');
  grid.set(trainX, 3, trainZ, 'minecraft:carved_pumpkin[facing=south]');
  grid.set(trainX + 2, 1, trainZ, 'minecraft:grindstone[face=floor,facing=north]');
  grid.set(trainX + 3, 1, trainZ, 'minecraft:anvil[facing=north]');

  // Market stalls
  const stallX = bx2 - 8;
  const stallZ = bz2 - 8;
  grid.set(stallX, 1, stallZ, style.fence);
  grid.set(stallX, 2, stallZ, 'minecraft:white_carpet');
  grid.set(stallX + 1, 1, stallZ, style.fence);
  grid.set(stallX + 1, 2, stallZ, 'minecraft:white_carpet');
  grid.set(stallX + 2, 1, stallZ, style.chairW);
  grid.fill(stallX - 1, 3, stallZ - 1, stallX + 2, 3, stallZ + 1, style.slabBottom);
  grid.set(stallX, 1, stallZ + 3, 'minecraft:hay_block');
  grid.set(stallX + 1, 1, stallZ + 3, 'minecraft:hay_block');
  grid.set(stallX, 2, stallZ + 3, 'minecraft:hay_block');
  grid.addBarrel(stallX + 2, 1, stallZ + 3, 'up', [
    { slot: 0, id: 'minecraft:apple', count: 32 },
  ]);

  // Torches in courtyard
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

  // Courtyard trees
  const treePosC: [number, number][] = [
    [bx1 + 8, bz2 - 6], [bx2 - 8, bz1 + 8],
  ];
  for (const [tx, tz] of treePosC) {
    if (grid.inBounds(tx, 1, tz)) placeTree(grid, tx, 1, tz, 'oak', 4);
  }

  // Guard armor stands
  for (const [tcx, tcz] of [[bx1 + 2, bz1 + 2], [bx2 - 2, bz1 + 2], [bx2 - 2, bz2 - 2]] as [number, number][]) {
    if (grid.inBounds(tcx, 1, tcz))
      grid.set(tcx, 1, tcz, 'minecraft:armor_stand');
  }

  // Varied tower heights
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

  // Courtyard garden patches
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

  // Stable area
  const stableX = bx2 - 6;
  const stableZ = bz1 + 4;
  grid.fill(stableX, 3, stableZ, stableX + 3, 3, stableZ + 2, style.slabBottom);
  for (let dz = 0; dz <= 2; dz++) {
    if (grid.inBounds(stableX, 1, stableZ + dz))
      grid.set(stableX, 1, stableZ + dz, style.fence);
    if (grid.inBounds(stableX + 3, 1, stableZ + dz))
      grid.set(stableX + 3, 1, stableZ + dz, style.fence);
  }
  if (grid.inBounds(stableX + 1, 1, stableZ))
    grid.set(stableX + 1, 1, stableZ, 'minecraft:hay_block');

  // Castle wall weathering
  const castleVariants = [
    'minecraft:mossy_stone_bricks', 'minecraft:cracked_stone_bricks',
    'minecraft:cobblestone',
  ];
  weatherWalls(grid, bx1, 0, bz1, bx2, wallH + 2, bz2, style.wall, castleVariants, rng, 0.12);

  // Weapon rack + archery targets
  const rackX = bx1 + 5;
  const rackZ = bz1 + 5;
  if (grid.inBounds(rackX, 1, rackZ))
    grid.set(rackX, 1, rackZ, 'minecraft:armor_stand');
  if (grid.inBounds(rackX + 1, 1, rackZ))
    grid.set(rackX + 1, 1, rackZ, 'minecraft:grindstone[face=floor,facing=north]');
  const targetX = bx2 - 5;
  const targetZ = bz1 + 5;
  if (grid.inBounds(targetX, 1, targetZ))
    grid.set(targetX, 1, targetZ, 'minecraft:hay_block');
  if (grid.inBounds(targetX, 2, targetZ))
    grid.set(targetX, 2, targetZ, 'minecraft:target');

  // More banners along inner curtain walls
  for (let x = bx1 + 6; x <= bx2 - 6; x += 8) {
    if (grid.inBounds(x, wallH, bz1 + 1))
      grid.set(x, wallH, bz1 + 1, style.bannerS);
    if (grid.inBounds(x, wallH, bz2 - 1))
      grid.set(x, wallH, bz2 - 1, style.bannerN);
  }

  // Dark Fortress unique features
  if (style.wall === 'minecraft:deepslate_bricks') {
    for (const [tcx, tcz] of towerCorners) {
      const spireTop = towerH + towerRadius + 4;
      for (let y = towerH + 3; y <= spireTop; y++) {
        if (grid.inBounds(tcx, y, tcz))
          grid.set(tcx, y, tcz, 'minecraft:blackstone');
      }
      if (grid.inBounds(tcx, spireTop + 1, tcz))
        grid.set(tcx, spireTop + 1, tcz, 'minecraft:soul_lantern[hanging=false]');
    }
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
    for (let x = bx1 + 5; x < bx2 - 3; x += 5) {
      if (grid.inBounds(x, 1, bz1 + 3))
        grid.set(x, 1, bz1 + 3, 'minecraft:soul_lantern[hanging=false]');
      if (grid.inBounds(x, 1, bz2 - 3))
        grid.set(x, 1, bz2 - 3, 'minecraft:soul_lantern[hanging=false]');
    }
    if (grid.inBounds(xMid - 2, wallH, bz2))
      grid.set(xMid - 2, wallH, bz2, 'minecraft:wither_skeleton_skull[rotation=0]');
    if (grid.inBounds(xMid + 2, wallH, bz2))
      grid.set(xMid + 2, wallH, bz2, 'minecraft:wither_skeleton_skull[rotation=0]');
    if (grid.inBounds(xMid, 3, bz2 - 1))
      grid.set(xMid, 3, bz2 - 1, 'minecraft:cobweb');
  }

  return grid;
}
