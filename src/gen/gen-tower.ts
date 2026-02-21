/**
 * Tower structure generator.
 * Extracted from gen-structures.ts for modularity.
 */

import { BlockGrid } from '../schem/types.js';
import { type RoomType, type RoomBounds } from '../types/index.js';
import { getRoomGenerator, getRoomTypes } from './rooms.js';
import { type StylePalette } from './styles.js';
import { 
  STORY_H,
  ROOF_H,
  pick,
  fillCircle,
  placeOutbuilding,
 } from './gen-utils.js';

// ─── Tower ──────────────────────────────────────────────────────────────────

export function generateTower(
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
