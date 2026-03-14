/**
 * Environment builder — populates a BlockGrid with scene elements around
 * a voxelized building. Adds ground cover, roads, sidewalks, footpaths,
 * fences, trees, pools, driveways, and garden patches.
 *
 * Uses the GeoProjection for coordinate conversion (lat/lng to grid XZ)
 * and respects existing building voxels (never overwrites non-air blocks
 * unless the target is explicitly ground-level air).
 *
 * Designed for the tiles pipeline where a building has already been
 * voxelized from Google 3D Tiles and we need to fill in the surroundings.
 */

import type { BlockGrid } from '../schem/types.js';
import type { SceneEnrichment, GeoPoint } from './scene-enrichment.js';
import { GeoProjection } from './geo-projection.js';
import { placeTree, placePool, placeGarden } from '../gen/structures.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Result statistics from environment building */
export interface EnvironmentStats {
  /** Number of trees successfully placed */
  treesPlaced: number;
  /** Number of road blocks placed */
  roadsPlaced: number;
  /** Number of fence blocks placed */
  fencesPlaced: number;
  /** Number of ground cover blocks placed */
  groundFilled: number;
}

// ─── Block Constants ────────────────────────────────────────────────────────

/** Ground cover blocks by biome classification */
const GROUND_BLOCKS: Record<string, string> = {
  grass: 'minecraft:grass_block',
  forest: 'minecraft:podzol',
  desert: 'minecraft:sand',
  urban: 'minecraft:smooth_stone',
};

/** Road surface blocks by OSM surface tag */
const ROAD_SURFACE_BLOCKS: Record<string, string> = {
  asphalt: 'minecraft:gray_concrete',
  concrete: 'minecraft:light_gray_concrete',
  paved: 'minecraft:gray_concrete',
  gravel: 'minecraft:gravel',
  dirt: 'minecraft:dirt_path',
  cobblestone: 'minecraft:cobblestone',
  paving_stones: 'minecraft:stone_bricks',
};

/** Sidewalk block (consistent across all road types) */
const SIDEWALK_BLOCK = 'minecraft:smooth_stone_slab[type=bottom]';

/** Path blocks — varies by material to break visual monotony */
const PATH_BLOCKS: Record<string, string> = {
  gravel: 'minecraft:gravel',
  dirt: 'minecraft:dirt_path',
  paved: 'minecraft:stone_brick_slab[type=bottom]',
  default: 'minecraft:cobblestone',
};

/** Fence blocks by OSM barrier/material tag */
const FENCE_MATERIAL_BLOCKS: Record<string, string> = {
  wood: 'minecraft:oak_fence',
  metal: 'minecraft:iron_bars',
  chain_link: 'minecraft:iron_bars',
  fence: 'minecraft:oak_fence',
  wall: 'minecraft:stone_brick_wall',
  hedge: 'minecraft:oak_leaves[persistent=true]',
  guard_rail: 'minecraft:iron_bars',
  retaining_wall: 'minecraft:cobblestone_wall',
  concrete: 'minecraft:gray_concrete',
};

/** Fence post block (taller marker every N blocks) */
const FENCE_POST_BLOCK = 'minecraft:oak_log';

/** Driveway block */
const DRIVEWAY_BLOCK = 'minecraft:gray_concrete';

/** Flower types for garden scatter */
const SCATTER_FLOWERS = [
  'minecraft:dandelion', 'minecraft:poppy', 'minecraft:blue_orchid',
  'minecraft:allium', 'minecraft:azure_bluet', 'minecraft:cornflower',
  'minecraft:lily_of_the_valley',
];

// ─── Geometry Helpers ───────────────────────────────────────────────────────

/**
 * Project an array of geographic nodes to grid XZ coordinates.
 *
 * @param nodes       Geographic points (lat/lng)
 * @param projection  GeoProjection for coordinate conversion
 * @returns Array of grid { x, z } coordinates
 */
export function projectNodesToGrid(
  nodes: GeoPoint[],
  projection: GeoProjection,
): { x: number; z: number }[] {
  return nodes.map(n => projection.toGridXZ(n.lat, n.lng));
}

/**
 * Rasterize a polyline into discrete grid cells using Bresenham-style
 * line walking with configurable width. Returns an array of unique XZ
 * coordinates that form the rasterized line.
 *
 * @param gridNodes  Array of grid coordinates (from projectNodesToGrid)
 * @param widthBlocks  Line width in blocks (centered on the polyline)
 * @param gridWidth  Grid width for bounds checking
 * @param gridLength Grid length for bounds checking
 * @returns Array of unique { x, z } grid cells
 */
export function rasterizePolyline(
  gridNodes: { x: number; z: number }[],
  widthBlocks: number,
  gridWidth: number,
  gridLength: number,
): { x: number; z: number }[] {
  const cells = new Map<string, { x: number; z: number }>();
  const halfW = Math.floor(widthBlocks / 2);

  for (let i = 0; i < gridNodes.length - 1; i++) {
    const { x: x0, z: z0 } = gridNodes[i];
    const { x: x1, z: z1 } = gridNodes[i + 1];

    const dx = x1 - x0;
    const dz = z1 - z0;
    const steps = Math.max(Math.abs(dx), Math.abs(dz));
    if (steps === 0) continue;

    for (let s = 0; s <= steps; s++) {
      const cx = Math.round(x0 + (dx * s) / steps);
      const cz = Math.round(z0 + (dz * s) / steps);

      // Expand perpendicular to the dominant direction for line width
      if (Math.abs(dx) >= Math.abs(dz)) {
        // Path runs along X — widen along Z
        for (let w = -halfW; w <= halfW; w++) {
          const wz = cz + w;
          if (cx >= 0 && cx < gridWidth && wz >= 0 && wz < gridLength) {
            cells.set(`${cx},${wz}`, { x: cx, z: wz });
          }
        }
      } else {
        // Path runs along Z — widen along X
        for (let w = -halfW; w <= halfW; w++) {
          const wx = cx + w;
          if (wx >= 0 && wx < gridWidth && cz >= 0 && cz < gridLength) {
            cells.set(`${wx},${cz}`, { x: wx, z: cz });
          }
        }
      }
    }
  }

  return Array.from(cells.values());
}

/**
 * Generate sidewalk cells by offsetting road cells perpendicular to the road.
 * Returns only cells that are NOT already in the road set.
 *
 * @param roadCells  Set of road cell keys ("x,z")
 * @param gridWidth  Grid width for bounds checking
 * @param gridLength Grid length for bounds checking
 * @returns Array of sidewalk { x, z } grid cells
 */
function generateSidewalkCells(
  roadCells: Set<string>,
  gridWidth: number,
  gridLength: number,
): { x: number; z: number }[] {
  const sidewalk: { x: number; z: number }[] = [];
  const seen = new Set<string>();

  // For each road cell, check all 4-connected neighbors; if a neighbor
  // is not a road cell, it's a sidewalk candidate
  for (const key of roadCells) {
    const [xStr, zStr] = key.split(',');
    const x = parseInt(xStr, 10);
    const z = parseInt(zStr, 10);

    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
      const nx = x + dx;
      const nz = z + dz;
      const nKey = `${nx},${nz}`;

      if (nx >= 0 && nx < gridWidth && nz >= 0 && nz < gridLength &&
          !roadCells.has(nKey) && !seen.has(nKey)) {
        seen.add(nKey);
        sidewalk.push({ x: nx, z: nz });
      }
    }
  }

  return sidewalk;
}

// ─── Building Bounds Detection ──────────────────────────────────────────────

/**
 * Detect the bounding box of existing non-air blocks at ground level (Y=0-1).
 * Used to determine building footprint for tree placement exclusion and
 * driveway routing.
 *
 * @param grid  BlockGrid with existing building voxels
 * @returns Bounding box { x1, z1, x2, z2 } of non-air blocks, or null if empty
 */
function detectBuildingBounds(grid: BlockGrid): {
  x1: number; z1: number; x2: number; z2: number;
} | null {
  let x1 = grid.width, z1 = grid.length, x2 = -1, z2 = -1;

  // Scan all Y levels to find the full building footprint
  // (buildings may have overhangs that extend beyond ground floor)
  for (let y = 0; y < Math.min(grid.height, 5); y++) {
    for (let z = 0; z < grid.length; z++) {
      for (let x = 0; x < grid.width; x++) {
        if (grid.get(x, y, z) !== 'minecraft:air') {
          if (x < x1) x1 = x;
          if (z < z1) z1 = z;
          if (x > x2) x2 = x;
          if (z > z2) z2 = z;
        }
      }
    }
  }

  if (x2 < 0) return null;
  return { x1, z1, x2, z2 };
}

// ─── Safe Write Helpers ─────────────────────────────────────────────────────

/**
 * Set a block only if the current block at that position is air.
 * This prevents overwriting existing building, road, or other placed blocks.
 *
 * @param grid  BlockGrid to write to
 * @param x     X coordinate
 * @param y     Y coordinate
 * @param z     Z coordinate
 * @param block Block state to place
 * @returns True if block was placed, false if skipped (non-air or out of bounds)
 */
function setIfAir(grid: BlockGrid, x: number, y: number, z: number, block: string): boolean {
  if (!grid.inBounds(x, y, z)) return false;
  if (grid.get(x, y, z) !== 'minecraft:air') return false;
  grid.set(x, y, z, block);
  return true;
}

/**
 * Check if a grid cell is inside the building bounds (with a margin).
 * Used to prevent placing trees, pools, or other features inside the building.
 *
 * @param x       Grid X
 * @param z       Grid Z
 * @param bounds  Building bounding box
 * @param margin  Extra margin in blocks around the building
 * @returns True if the cell is inside the building + margin area
 */
function isInsideBuilding(
  x: number,
  z: number,
  bounds: { x1: number; z1: number; x2: number; z2: number },
  margin = 2,
): boolean {
  return x >= bounds.x1 - margin && x <= bounds.x2 + margin &&
         z >= bounds.z1 - margin && z <= bounds.z2 + margin;
}

// ─── Main Environment Builder ───────────────────────────────────────────────

/**
 * Populate a BlockGrid with environment elements around a building.
 * Builds ground cover, roads, sidewalks, footpaths, fences, trees,
 * pools, driveways, and garden patches using real-world data from
 * SceneEnrichment.
 *
 * Never overwrites existing non-air voxels (building blocks are sacred).
 * Uses heightmap for terrain variation when provided.
 *
 * @param grid         The BlockGrid (building already voxelized)
 * @param enrichment   Scene enrichment data from APIs
 * @param projection   GeoProjection for coordinate conversion
 * @param heightmap    Optional terrain heightmap (Float32Array, indexed by z*width+x)
 * @param options      Optional config
 * @returns Statistics about what was placed
 */
export function buildEnvironment(
  grid: BlockGrid,
  enrichment: SceneEnrichment,
  projection: GeoProjection,
  heightmap?: Float32Array,
  options?: {
    /** Override plot radius in blocks (default: auto from grid dimensions) */
    plotRadius?: number;
  },
): EnvironmentStats {
  const stats: EnvironmentStats = {
    treesPlaced: 0,
    roadsPlaced: 0,
    fencesPlaced: 0,
    groundFilled: 0,
  };

  const { width, length } = grid;
  const buildingBounds = detectBuildingBounds(grid);

  // plotRadius: limit environment fill distance from grid center.
  // When specified, skip ground fill outside this radius for performance.
  const plotRadius = options?.plotRadius ?? Math.max(width, length);

  // Helper to get ground Y at a given XZ position from heightmap
  const groundY = (x: number, z: number): number => {
    if (!heightmap) return 0;
    const idx = z * width + x;
    if (idx < 0 || idx >= heightmap.length) return 0;
    return Math.max(0, Math.round(heightmap[idx]));
  };

  // Track which cells have been claimed by roads/paths/fences
  // to avoid overlapping features
  const claimedCells = new Set<string>();

  // ── Step 1: Roads ─────────────────────────────────────────────────
  // Process roads first since they have highest priority for ground features
  for (const road of enrichment.roads) {
    const gridNodes = projectNodesToGrid(road.nodes, projection);

    // Scale road width: road.width is in meters, resolution converts to blocks
    const resolution = projection.getResolution();
    const widthBlocks = Math.max(3, Math.min(7,
      Math.round(road.width * resolution)));

    const roadCells = rasterizePolyline(gridNodes, widthBlocks, width, length);

    // Determine road surface block
    const surfaceBlock = ROAD_SURFACE_BLOCKS[road.surface] ??
      ROAD_SURFACE_BLOCKS['asphalt'];

    // Place road blocks
    const roadCellKeys = new Set<string>();
    for (const { x, z } of roadCells) {
      const y = groundY(x, z);
      if (setIfAir(grid, x, y, z, surfaceBlock)) {
        stats.roadsPlaced++;
      }
      const key = `${x},${z}`;
      roadCellKeys.add(key);
      claimedCells.add(key);
    }

    // Place sidewalks on both sides of the road
    const sidewalkCells = generateSidewalkCells(roadCellKeys, width, length);
    for (const { x, z } of sidewalkCells) {
      const key = `${x},${z}`;
      if (claimedCells.has(key)) continue;
      const y = groundY(x, z);
      if (setIfAir(grid, x, y, z, SIDEWALK_BLOCK)) {
        stats.groundFilled++;
      }
      claimedCells.add(key);
    }
  }

  // ── Step 2: Footpaths ─────────────────────────────────────────────
  for (const path of enrichment.paths) {
    const gridNodes = projectNodesToGrid(path.nodes, projection);
    const resolution = projection.getResolution();
    const widthBlocks = Math.max(1, Math.min(2,
      Math.round(path.width * resolution)));

    const pathCells = rasterizePolyline(gridNodes, widthBlocks, width, length);
    const pathBlock = PATH_BLOCKS['default'];

    for (const { x, z } of pathCells) {
      const key = `${x},${z}`;
      if (claimedCells.has(key)) continue;
      const y = groundY(x, z);
      if (setIfAir(grid, x, y, z, pathBlock)) {
        stats.groundFilled++;
      }
      claimedCells.add(key);
    }
  }

  // ── Step 3: Fences ────────────────────────────────────────────────
  for (const fence of enrichment.fences) {
    const gridNodes = projectNodesToGrid(fence.nodes, projection);
    const fenceCells = rasterizePolyline(gridNodes, 1, width, length);

    // Map OSM fence material to Minecraft block
    const fenceBlock = FENCE_MATERIAL_BLOCKS[fence.material] ??
      FENCE_MATERIAL_BLOCKS['fence'];
    const isWallType = fenceBlock.includes('_wall') || fenceBlock === 'minecraft:iron_bars';

    for (let i = 0; i < fenceCells.length; i++) {
      const { x, z } = fenceCells[i];
      const y = groundY(x, z);

      // Place fence block 1 above ground
      if (setIfAir(grid, x, y + 1, z, fenceBlock)) {
        stats.fencesPlaced++;
      }

      // Place fence posts every 4 blocks (taller markers for visual rhythm)
      if (i % 4 === 0 && !isWallType) {
        if (setIfAir(grid, x, y + 2, z, FENCE_POST_BLOCK)) {
          stats.fencesPlaced++;
        }
      }

      claimedCells.add(`${x},${z}`);
    }
  }

  // ── Step 4: Trees ─────────────────────────────────────────────────
  for (const tree of enrichment.trees) {
    const { x, z } = projection.toGridXZ(tree.lat, tree.lng);

    // Skip trees outside grid bounds
    if (x < 0 || x >= width || z < 0 || z >= length) continue;

    // Skip trees inside building bounds (with margin for canopy clearance)
    if (buildingBounds && isInsideBuilding(x, z, buildingBounds, 3)) continue;

    // Skip trees on claimed road/path cells
    if (claimedCells.has(`${x},${z}`)) continue;

    const y = groundY(x, z);

    // placeTree writes directly to grid — it handles its own bounds checking.
    // We place at y+1 so tree trunk starts above the ground block.
    // First, ensure there's a ground block beneath the tree
    setIfAir(grid, x, y, z, GROUND_BLOCKS[enrichment.groundCover] ?? 'minecraft:grass_block');
    placeTree(grid, x, y + 1, z, tree.species, tree.height);
    stats.treesPlaced++;
  }

  // ── Step 5: Pool ──────────────────────────────────────────────────
  if (enrichment.hasPool && buildingBounds) {
    // Place pool south of building center (higher Z = south in MC)
    const poolCx = Math.floor((buildingBounds.x1 + buildingBounds.x2) / 2);
    const poolCz = buildingBounds.z2 + 6; // 6 blocks south of building edge

    // Check that pool area is within grid bounds and not overlapping roads
    const poolW = 5;
    const poolL = 7;
    const poolX1 = poolCx - Math.floor(poolW / 2);
    const poolX2 = poolX1 + poolW - 1;
    const poolZ1 = poolCz - Math.floor(poolL / 2);
    const poolZ2 = poolZ1 + poolL - 1;

    // Verify pool fits within grid and doesn't overlap claimed cells
    let poolFits = poolX1 >= 1 && poolX2 < width - 1 &&
                   poolZ1 >= 1 && poolZ2 < length - 1;

    if (poolFits) {
      // Check no claimed cells overlap pool area (including border)
      for (let px = poolX1 - 1; px <= poolX2 + 1 && poolFits; px++) {
        for (let pz = poolZ1 - 1; pz <= poolZ2 + 1 && poolFits; pz++) {
          if (claimedCells.has(`${px},${pz}`)) poolFits = false;
        }
      }
    }

    if (poolFits) {
      const y = groundY(poolCx, poolCz);
      placePool(grid, poolCx, poolCz, poolW, poolL, y);
      // Claim pool cells
      for (let px = poolX1 - 1; px <= poolX2 + 1; px++) {
        for (let pz = poolZ1 - 1; pz <= poolZ2 + 1; pz++) {
          claimedCells.add(`${px},${pz}`);
        }
      }
    }
  }

  // ── Step 6: Driveway ──────────────────────────────────────────────
  if (enrichment.hasDriveway && buildingBounds) {
    // Driveway extends from building front (south face, high Z) toward
    // the nearest road, or toward the grid edge if no road found
    const driveCx = Math.floor((buildingBounds.x1 + buildingBounds.x2) / 2);
    const driveStartZ = buildingBounds.z2 + 1;
    const halfW = 1; // 3-wide driveway

    // Find the nearest road Z to connect to, or extend to grid edge
    let driveEndZ = Math.min(length - 1, driveStartZ + 12);
    for (let z = driveStartZ; z < length; z++) {
      if (claimedCells.has(`${driveCx},${z}`)) {
        // Found a road — stop the driveway here
        driveEndZ = z - 1;
        break;
      }
    }

    // Place driveway blocks
    for (let z = driveStartZ; z <= driveEndZ; z++) {
      for (let dx = -halfW; dx <= halfW; dx++) {
        const x = driveCx + dx;
        const key = `${x},${z}`;
        if (claimedCells.has(key)) continue;
        const y = groundY(x, z);
        if (setIfAir(grid, x, y, z, DRIVEWAY_BLOCK)) {
          stats.roadsPlaced++;
        }
        claimedCells.add(key);
      }
    }
  }

  // ── Step 7: Garden patches ────────────────────────────────────────
  // Scatter small garden patches near the building in unclaimed areas
  if (buildingBounds) {
    // Seeded RNG for deterministic garden placement
    const center = projection.getCenter();
    let gardenSeed = Math.abs(Math.round(center.lat * 1e6) ^ Math.round(center.lng * 1e6));
    const gardenRng = (): number => {
      gardenSeed = (gardenSeed * 1664525 + 1013904223) & 0x7FFFFFFF;
      return gardenSeed / 0x7FFFFFFF;
    };

    // Place up to 3 small garden patches near building corners
    const gardenSpots = [
      { x: buildingBounds.x1 - 3, z: buildingBounds.z1 - 3 },
      { x: buildingBounds.x2 + 2, z: buildingBounds.z1 - 3 },
      { x: buildingBounds.x1 - 3, z: buildingBounds.z2 + 2 },
    ];

    for (const spot of gardenSpots) {
      const gx1 = spot.x;
      const gz1 = spot.z;
      const gx2 = gx1 + 3;
      const gz2 = gz1 + 3;

      // Check the garden fits within grid and doesn't overlap claimed cells
      if (gx1 < 0 || gx2 >= width || gz1 < 0 || gz2 >= length) continue;

      let gardenFits = true;
      for (let gx = gx1; gx <= gx2 && gardenFits; gx++) {
        for (let gz = gz1; gz <= gz2 && gardenFits; gz++) {
          if (claimedCells.has(`${gx},${gz}`)) gardenFits = false;
          // Also skip if non-air blocks exist (building overhang, etc.)
          const gy = groundY(gx, gz);
          if (grid.get(gx, gy, gz) !== 'minecraft:air' &&
              grid.get(gx, gy + 1, gz) !== 'minecraft:air') {
            gardenFits = false;
          }
        }
      }

      if (gardenFits) {
        const gy = groundY(gx1, gz1);
        placeGarden(grid, gx1, gz1, gx2, gz2, gy, gardenRng);
        // Claim garden cells
        for (let gx = gx1; gx <= gx2; gx++) {
          for (let gz = gz1; gz <= gz2; gz++) {
            claimedCells.add(`${gx},${gz}`);
          }
        }
      }
    }
  }

  // ── Step 8: Ground cover fill ─────────────────────────────────────
  // Fill remaining air cells at Y=0 with biome-appropriate ground blocks.
  // This gives the scene a complete ground plane instead of floating in air.
  const groundBlock = GROUND_BLOCKS[enrichment.groundCover] ?? 'minecraft:grass_block';

  // Seeded RNG for ground variation (e.g., scattered flowers in grass)
  const center = projection.getCenter();
  let groundSeed = Math.abs(Math.round(center.lat * 1e6 + center.lng * 1e6));
  const groundRng = (): number => {
    groundSeed = (groundSeed * 1664525 + 1013904223) & 0x7FFFFFFF;
    return groundSeed / 0x7FFFFFFF;
  };

  const gridCx = Math.floor(width / 2);
  const gridCz = Math.floor(length / 2);
  const plotRadiusSq = plotRadius * plotRadius;

  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      // Skip cells outside plotRadius from grid center (performance optimization)
      const dx = x - gridCx;
      const dz = z - gridCz;
      if (dx * dx + dz * dz > plotRadiusSq) continue;

      const key = `${x},${z}`;
      if (claimedCells.has(key)) continue;

      const y = groundY(x, z);
      if (setIfAir(grid, x, y, z, groundBlock)) {
        stats.groundFilled++;

        // 5% chance to scatter a flower on grass/forest ground
        if ((enrichment.groundCover === 'grass' || enrichment.groundCover === 'forest') &&
            groundRng() < 0.05) {
          const flowerIdx = Math.floor(groundRng() * SCATTER_FLOWERS.length);
          setIfAir(grid, x, y + 1, z, SCATTER_FLOWERS[flowerIdx]);
        }
      }
    }
  }

  return stats;
}
