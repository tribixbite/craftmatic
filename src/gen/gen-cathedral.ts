/**
 * Cathedral structure generator.
 * Extracted from gen-structures.ts for modularity.
 */

import { BlockGrid } from '../schem/types.js';
import { type RoomType } from '../types/index.js';
import { foundation, gabledRoof } from './structures.js';
import { chandelier } from './furniture.js';
import { type StylePalette } from './styles.js';
import { STORY_H, ROOF_H, placeOutbuilding } from './gen-utils.js';

// ─── Cathedral ───────────────────────────────────────────────────────────────

export function generateCathedral(
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
