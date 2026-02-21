/**
 * Village structure generator.
 * Extracted from gen-structures.ts for modularity.
 */

import { BlockGrid } from '../schem/types.js';
import { type RoomType } from '../types/index.js';
import { placeTree, placeGarden } from './structures.js';
import { type StylePalette } from './styles.js';
import { 
  STORY_H,
  ROOF_H,
  pasteGrid,
  pasteGridFlipZ,
  fillCircle,
 } from './gen-utils.js';
import { generateHouse } from './gen-house.js';
import { generateTower } from './gen-tower.js';
import { generateMarketplace } from './gen-marketplace.js';

// ─── Village ─────────────────────────────────────────────────────────────────

export function generateVillage(
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

  // Building placement — ring layout around central plaza
  // Houses face south (high-Z porch). South-side buildings get Z-flipped to face inward.
  const buildingSpots: { x: number; z: number; w: number; l: number; type: 'house' | 'tower' | 'marketplace'; doorX: number; doorZ: number; flipZ: boolean }[] = [];

  const bldgMargin = 3; // internal margin in sub-grids
  // Ring radius: center of buildings from village center (28 prevents overlap)
  const ringR = 28;

  // Place buildings at 6 angular positions around the plaza (clock positions)
  // Position 0 (north): marketplace
  // Position 1-4: houses
  // Position 5: tower
  const angles = [
    { angle: 0, type: 'marketplace' as const },   // north
    { angle: 60, type: 'house' as const },          // NE
    { angle: 120, type: 'house' as const },         // SE
    { angle: 180, type: 'house' as const },         // south
    { angle: 240, type: 'house' as const },         // SW
    { angle: 300, type: 'tower' as const },         // NW
  ];

  for (const slot of angles) {
    const rad = (slot.angle * Math.PI) / 180;
    // Building center in village coordinates
    const bCenterX = cx + Math.round(ringR * Math.sin(rad));
    const bCenterZ = cz - Math.round(ringR * Math.cos(rad));
    // South half of village = flip so porch faces north (toward center)
    const needFlip = slot.angle > 90 && slot.angle < 270;

    if (slot.type === 'marketplace') {
      const mpW = 18, mpL = 14;
      const mpX = bCenterX - Math.floor(mpW / 2) - bldgMargin;
      const mpZ = bCenterZ - Math.floor(mpL / 2) - bldgMargin;
      buildingSpots.push({
        x: mpX, z: mpZ, w: mpW, l: mpL, type: 'marketplace',
        doorX: bCenterX, doorZ: needFlip ? mpZ + bldgMargin : mpZ + bldgMargin + mpL,
        flipZ: needFlip,
      });
    } else if (slot.type === 'tower') {
      const twSize = 10;
      const twX = bCenterX - Math.floor(twSize / 2) - bldgMargin;
      const twZ = bCenterZ - Math.floor(twSize / 2) - bldgMargin;
      buildingSpots.push({
        x: twX, z: twZ, w: twSize, l: twSize, type: 'tower',
        doorX: bCenterX, doorZ: needFlip ? twZ + bldgMargin : twZ + bldgMargin + twSize,
        flipZ: needFlip,
      });
    } else {
      const hw = 13 + Math.floor(rng() * 4);  // 13-16
      const hl = 11 + Math.floor(rng() * 4);  // 11-14
      const hx = bCenterX - Math.floor(hw / 2) - bldgMargin;
      const hz = bCenterZ - Math.floor(hl / 2) - bldgMargin;
      buildingSpots.push({
        x: hx, z: hz, w: hw, l: hl, type: 'house',
        doorX: bCenterX, doorZ: needFlip ? hz + bldgMargin : hz + bldgMargin + hl,
        flipZ: needFlip,
      });
    }
  }

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
    if (spot.flipZ) {
      pasteGridFlipZ(grid, subGrid, spot.x, 0, spot.z);
    } else {
      pasteGrid(grid, subGrid, spot.x, 0, spot.z);
    }
  }

  // ── Upgraded paths — route from each building's door to the center well ──
  const wellX = cx;
  const wellZ = cz;
  for (const spot of buildingSpots) {
    const sx = spot.doorX;
    const sz = spot.doorZ;
    // L-shaped path: first move horizontally (X) to align with well, then vertically (Z)
    const startX = Math.min(sx, wellX);
    const endX = Math.max(sx, wellX);
    for (let x = startX; x <= endX; x++) {
      for (let dz = -1; dz <= 0; dz++) {
        if (grid.inBounds(x, 0, sz + dz))
          grid.set(x, 0, sz + dz, 'minecraft:stone_bricks');
      }
    }
    // Vertical segment from door-Z to well-Z
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
