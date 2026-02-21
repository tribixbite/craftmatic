/**
 * Windmill structure generator.
 * Extracted from gen-structures.ts for modularity.
 */

import { BlockGrid } from '../schem/types.js';
import { type RoomType } from '../types/index.js';
import { type StylePalette } from './styles.js';
import { STORY_H, fillCircle, placeOutbuilding } from './gen-utils.js';

// ─── Windmill ────────────────────────────────────────────────────────────────

export function generateWindmill(
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

  // ── Windmill exterior detail — grain sacks, weathered base, outdoor elements ──
  // Grain sack pile outside entrance
  const doorZw = cz - baseR;
  if (grid.inBounds(cx + 2, 1, doorZw - 1))
    grid.set(cx + 2, 1, doorZw - 1, 'minecraft:hay_block');
  if (grid.inBounds(cx + 3, 1, doorZw - 1))
    grid.set(cx + 3, 1, doorZw - 1, 'minecraft:hay_block');
  if (grid.inBounds(cx + 2, 2, doorZw - 1))
    grid.set(cx + 2, 2, doorZw - 1, 'minecraft:hay_block');
  // Barrel for flour storage
  if (grid.inBounds(cx - 2, 1, doorZw - 1))
    grid.addBarrel(cx - 2, 1, doorZw - 1, 'up', [
      { slot: 0, id: 'minecraft:bread', count: 64 },
    ]);
  // Weathered base walls — mix in cobblestone at ground level
  for (let dx = -baseR; dx <= baseR; dx++) {
    for (let dz = -baseR; dz <= baseR; dz++) {
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= baseR - 0.5 && dist <= baseR + 0.5) {
        const bx = cx + dx;
        const bz = cz + dz;
        if (grid.inBounds(bx, 1, bz) && grid.get(bx, 1, bz) === style.wall) {
          // 20% chance to replace ground-level wall blocks with cobblestone
          if ((dx * 7 + dz * 13) % 5 === 0)
            grid.set(bx, 1, bz, 'minecraft:cobblestone');
        }
      }
    }
  }
  // Outdoor path — cobblestone path leading to door
  for (let pz = doorZw - 2; pz >= doorZw - 5; pz--) {
    if (grid.inBounds(cx, 0, pz))
      grid.set(cx, 0, pz, 'minecraft:cobblestone');
    if (grid.inBounds(cx - 1, 0, pz))
      grid.set(cx - 1, 0, pz, 'minecraft:cobblestone');
  }
  // Lantern by door
  if (grid.inBounds(cx - 1, 1, doorZw - 1))
    grid.set(cx - 1, 1, doorZw - 1, style.lanternFloor);

  // ── Grain storage shed + fenced wheat field — windmill composition ──
  // Shed to the east of windmill
  const wShedX = cx + baseR + 4;
  const wShedZ = cz - 2;
  if (grid.inBounds(wShedX + 5, 5, wShedZ + 4))
    placeOutbuilding(grid, wShedX, wShedZ, 5, 5, 3, style, 'lean-to');
  // Path from windmill to shed
  for (let x = cx + baseR + 1; x <= wShedX; x++) {
    if (grid.inBounds(x, 0, cz))
      grid.set(x, 0, cz, 'minecraft:cobblestone');
  }
  // Wheat field (south of windmill, fenced)
  const fieldX1 = cx - baseR - 1;
  const fieldX2 = cx + baseR + 1;
  const fieldZ1 = cz + baseR + 3;
  const fieldZ2 = Math.min(grid.length - 2, fieldZ1 + 6);
  if (grid.inBounds(fieldX2, 0, fieldZ2)) {
    for (let x = fieldX1; x <= fieldX2; x++) {
      for (let z = fieldZ1; z <= fieldZ2; z++) {
        if (grid.inBounds(x, 0, z)) {
          grid.set(x, 0, z, 'minecraft:farmland[moisture=7]');
          if (grid.inBounds(x, 1, z))
            grid.set(x, 1, z, 'minecraft:wheat[age=7]');
        }
      }
    }
    // Fence around field
    for (let x = fieldX1 - 1; x <= fieldX2 + 1; x++) {
      if (grid.inBounds(x, 1, fieldZ1 - 1)) grid.set(x, 1, fieldZ1 - 1, style.fence);
      if (grid.inBounds(x, 1, fieldZ2 + 1)) grid.set(x, 1, fieldZ2 + 1, style.fence);
    }
    for (let z = fieldZ1 - 1; z <= fieldZ2 + 1; z++) {
      if (grid.inBounds(fieldX1 - 1, 1, z)) grid.set(fieldX1 - 1, 1, z, style.fence);
      if (grid.inBounds(fieldX2 + 1, 1, z)) grid.set(fieldX2 + 1, 1, z, style.fence);
    }
  }

  return grid;
}
