/**
 * Bridge structure generator.
 * Extracted from gen-structures.ts for modularity.
 */

import { BlockGrid } from '../schem/types.js';
import { type RoomType } from '../types/index.js';
import { exteriorWalls, windows } from './structures.js';
import { type StylePalette } from './styles.js';

// ─── Bridge ──────────────────────────────────────────────────────────────────

export function generateBridge(
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

  // Parabolic arch underneath with inner ribs for depth
  const midZ = Math.floor((bz1 + bz2) / 2);
  const halfSpan = (bz2 - bz1) / 2;
  for (let z = bz1; z <= bz2; z++) {
    const t = (z - midZ) / halfSpan; // -1 to 1
    const archTop = deckY - 1 - Math.round(archH * (1 - t * t)); // parabola
    // Outer arch ribs at edges
    for (const x of [bx1, bx2]) {
      for (let y = Math.max(0, archTop); y <= deckY - 1; y++) {
        if (grid.inBounds(x, y, z)) grid.set(x, y, z, style.wall);
      }
    }
    // Inner arch ribs at bx1+1 and bx2-1 for structural depth from side view
    for (const x of [bx1 + 1, bx2 - 1]) {
      for (let y = Math.max(0, archTop); y <= deckY - 1; y++) {
        if (grid.inBounds(x, y, z)) grid.set(x, y, z, style.wallAccent);
      }
    }
    // Arch bottom face
    if (archTop >= 0 && grid.inBounds(cx, archTop, z)) {
      for (let x = bx1; x <= bx2; x++) {
        if (grid.inBounds(x, archTop, z)) grid.set(x, archTop, z, style.wall);
      }
    }
  }

  // Varied railings — alternating fence and stone wall accent posts
  for (let z = bz1; z <= bz2; z++) {
    // Every 4th block is a stone wall accent post, rest are fence
    const isAccent = (z - bz1) % 4 === 0;
    const railBlock = isAccent ? style.wallAccent : style.fence;
    grid.set(bx1, deckY + 1, z, railBlock);
    grid.set(bx2, deckY + 1, z, railBlock);
  }

  // Lamp posts every 4 blocks on railings — fence post topped with lantern
  for (let z = bz1 + 2; z <= bz2 - 2; z += 4) {
    grid.set(bx1, deckY + 2, z, style.fence);
    grid.set(bx1, deckY + 3, z, style.lanternFloor);
    grid.set(bx2, deckY + 2, z, style.fence);
    grid.set(bx2, deckY + 3, z, style.lanternFloor);
  }

  // Bench seating — stair-block benches facing outward, pairs every 8 blocks
  for (let z = bz1 + 4; z <= bz2 - 4; z += 8) {
    // Bench facing west (left side of bridge)
    if (grid.inBounds(bx1 + 1, deckY + 1, z))
      grid.set(bx1 + 1, deckY + 1, z, 'minecraft:stone_brick_stairs[facing=west]');
    // Bench facing east (right side of bridge)
    if (grid.inBounds(bx2 - 1, deckY + 1, z))
      grid.set(bx2 - 1, deckY + 1, z, 'minecraft:stone_brick_stairs[facing=east]');
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

  // Center path accent — stone brick center strip with wallAccent side strips
  for (let z = bz1; z <= bz2; z++) {
    grid.set(cx, deckY, z, 'minecraft:stone_bricks');
    // Side accent strips flanking center
    if (grid.inBounds(cx - 1, deckY, z))
      grid.set(cx - 1, deckY, z, style.wallAccent);
    if (grid.inBounds(cx + 1, deckY, z))
      grid.set(cx + 1, deckY, z, style.wallAccent);
  }

  // ── Arch buttresses — support pillars underneath at regular intervals ──
  for (let z = bz1 + 4; z <= bz2 - 4; z += 6) {
    for (const x of [bx1 - 1, bx2 + 1]) {
      if (!grid.inBounds(x, 0, z)) continue;
      // Tapered buttress: wider at base, narrows upward
      for (let y = 0; y < deckY; y++) {
        grid.set(x, y, z, style.wall);
        // Wider base blocks on first 2 layers
        if (y < 2 && grid.inBounds(x + (x < cx ? -1 : 1), y, z))
          grid.set(x + (x < cx ? -1 : 1), y, z, style.wallAccent);
      }
    }
  }

  // ── Tower banners — decorative banners on tower exteriors ──
  for (const tz of [bz1 - towerSize, bz2 + 1]) {
    const tz2 = tz + towerSize - 1;
    const bannerY = deckY + 5;
    // Banners on north and south faces of each tower
    if (grid.inBounds(cx, bannerY, tz)) grid.set(cx, bannerY, tz, style.bannerN);
    if (grid.inBounds(cx, bannerY, tz2)) grid.set(cx, bannerY, tz2, style.bannerS);
    // Tower-top lanterns at corners
    for (const tx of [bx1 - 1, bx2 + 1]) {
      if (grid.inBounds(tx, deckY + 9, tz))
        grid.set(tx, deckY + 9, tz, style.lanternFloor);
      if (grid.inBounds(tx, deckY + 9, tz2))
        grid.set(tx, deckY + 9, tz2, style.lanternFloor);
    }
  }

  // ── Arch keystone — accent block at the peak of each arch rib ──
  grid.set(bx1, deckY - 1, midZ, style.wallAccent);
  grid.set(bx2, deckY - 1, midZ, style.wallAccent);

  // ── Deck surface variation — cobblestone/brick pattern instead of flat ──
  for (let z = bz1; z <= bz2; z++) {
    for (let x = bx1 + 1; x <= bx2 - 1; x++) {
      if (grid.inBounds(x, deckY, z)) {
        // Checkerboard pattern of two stone types
        const block = (x + z) % 2 === 0 ? 'minecraft:stone_bricks' : 'minecraft:polished_andesite';
        grid.set(x, deckY, z, block);
      }
    }
  }

  // ── Statue pedestals at bridge midpoint — guardian figures ──
  for (const sx of [bx1 + 1, bx2 - 1]) {
    if (grid.inBounds(sx, deckY + 1, midZ))
      grid.set(sx, deckY + 1, midZ, style.wallAccent); // pedestal
    if (grid.inBounds(sx, deckY + 2, midZ))
      grid.set(sx, deckY + 2, midZ, 'minecraft:armor_stand'); // statue
  }

  // ── Hanging chain lanterns beneath deck for underside detail ──
  for (let z = bz1 + 4; z <= bz2 - 4; z += 6) {
    if (grid.inBounds(cx, deckY - 1, z))
      grid.set(cx, deckY - 1, z, 'minecraft:chain');
    if (grid.inBounds(cx, deckY - 2, z))
      grid.set(cx, deckY - 2, z, style.lanternFloor);
  }

  // ── Gatehouse / toll booth at bridge entrance (south end) ──
  const ghBX1 = bx1 - 2;
  const ghBX2 = bx2 + 2;
  const ghBZ1 = bz2 + 1;
  const ghBZ2 = ghBZ1 + 4;
  const ghBH = 5;
  if (grid.inBounds(ghBX2, ghBH + 3, ghBZ2)) {
    for (let y = deckY + 1; y <= deckY + ghBH; y++) {
      for (let x = ghBX1; x <= ghBX2; x++) {
        grid.set(x, y, ghBZ1, style.wall);
        grid.set(x, y, ghBZ2, style.wall);
      }
      for (let z = ghBZ1; z <= ghBZ2; z++) {
        grid.set(ghBX1, y, z, style.wall);
        grid.set(ghBX2, y, z, style.wall);
      }
    }
    // Gatehouse floor
    for (let x = ghBX1; x <= ghBX2; x++) {
      for (let z = ghBZ1; z <= ghBZ2; z++) {
        if (grid.inBounds(x, deckY, z))
          grid.set(x, deckY, z, style.floorGround);
      }
    }
    // Passage through gatehouse
    for (let y = deckY + 1; y <= deckY + 3; y++) {
      grid.set(cx, y, ghBZ1, 'minecraft:air');
      grid.set(cx, y, ghBZ2, 'minecraft:air');
      grid.set(cx + 1, y, ghBZ1, 'minecraft:air');
      grid.set(cx + 1, y, ghBZ2, 'minecraft:air');
    }
    // Gatehouse battlements
    for (let x = ghBX1; x <= ghBX2; x += 2) {
      if (grid.inBounds(x, deckY + ghBH + 1, ghBZ1))
        grid.set(x, deckY + ghBH + 1, ghBZ1, style.wall);
      if (grid.inBounds(x, deckY + ghBH + 1, ghBZ2))
        grid.set(x, deckY + ghBH + 1, ghBZ2, style.wall);
    }
    // Windows on gatehouse
    if (grid.inBounds(cx, deckY + 3, ghBZ1 + 2))
      grid.set(ghBX1, deckY + 3, ghBZ1 + 2, style.window);
    if (grid.inBounds(ghBX2, deckY + 3, ghBZ1 + 2))
      grid.set(ghBX2, deckY + 3, ghBZ1 + 2, style.window);
  }

  return grid;
}
