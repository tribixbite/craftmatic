/**
 * Scene pipeline orchestrator — top-level function that composes the full
 * address-to-scene flow: geocode → building bounds → voxelize → classify →
 * enrich → build environment → export.
 *
 * This is the unified entry point for both CLI and browser scene generation.
 * The building comes from photogrammetry (GLB), and the environment is
 * populated procedurally using real-world data from 10+ API sources.
 *
 * Usage (CLI):
 *   import { addressToScene } from './scene-pipeline.js';
 *   const result = await addressToScene({
 *     glbPath: '/path/to/captured.glb',
 *     coords: { lat: 37.7567, lng: -122.4313 },
 *     resolution: 1,
 *     outputPath: '/path/to/output.schem',
 *   });
 */

import { BlockGrid } from '../schem/types.js';
import { classifyGrid, VoxelClass, writeWithPriority } from './voxel-classifier.js';
import type { ClassifiedGrid } from './voxel-classifier.js';
import { resolveBlock } from './class-block-map.js';
import type { BlockContext } from './class-block-map.js';
import { GeoProjection } from './geo-projection.js';
import { enrichForScene } from './scene-enrichment.js';
import type { SceneEnrichment } from './scene-enrichment.js';
import type { ExtractedEnvironment } from './mesh-filter.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Options for the scene pipeline */
export interface ScenePipelineOptions {
  /** Pre-voxelized BlockGrid (from tiles pipeline or GLB voxelizer) */
  grid: BlockGrid;
  /** Building center coordinates (required for enrichment API calls) */
  coords: { lat: number; lng: number };
  /** Blocks per meter (default: 1) */
  resolution?: number;
  /** Plot radius in meters for enrichment queries (default: 40) */
  plotRadius?: number;
  /** Terrain heightmap from tile capture (Float32Array indexed z*width+x) */
  terrainHeightmap?: Float32Array;
  /** Heightmap dimensions (must match if terrainHeightmap is provided) */
  heightmapWidth?: number;
  heightmapLength?: number;
  /** Calibration offset from alignOSMToFootprint (grid units) */
  calibrationDx?: number;
  calibrationDz?: number;
  /** Property flags from assessor/API data */
  propertyFlags?: {
    hasPool?: boolean;
    hasDriveway?: boolean;
    hasFence?: boolean;
    hardinessZone?: number;
    stateAbbreviation?: string;
  };
  /** Captured environment data from photogrammetry (from extractEnvironmentPositions) */
  capturedEnvironment?: ExtractedEnvironment;
  /** Progress callback for status updates */
  onProgress?: (msg: string) => void;
}

/** Metadata returned alongside the enriched grid */
export interface SceneMeta {
  /** Number of voxels classified by type */
  classificationCounts: Record<string, number>;
  /** Enrichment data used to populate the scene */
  enrichment: SceneEnrichment;
  /** Statistics from environment building */
  envStats: {
    treesPlaced: number;
    roadsPlaced: number;
    fencesPlaced: number;
    groundFilled: number;
  };
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

/**
 * Enrich a voxelized building grid with environment elements.
 *
 * Takes a BlockGrid containing just the building (from the tiles/GLB pipeline)
 * and adds trees, ground cover, roads, sidewalks, fences, pools, and other
 * scene elements based on real-world data from OSM, climate APIs, and
 * property records.
 *
 * The building voxels are never overwritten — the write priority system
 * ensures BUILDING_WALL(100) > FENCE(50) > ROAD(30) > GROUND(10).
 *
 * @param options  Pipeline configuration
 * @returns The enriched grid with classification metadata
 */
export async function enrichScene(
  options: ScenePipelineOptions,
): Promise<{ grid: BlockGrid; classified: ClassifiedGrid; meta: SceneMeta }> {
  const {
    grid,
    coords,
    resolution = 1,
    plotRadius = 40,
    terrainHeightmap,
    calibrationDx = 0,
    calibrationDz = 0,
    propertyFlags,
    capturedEnvironment,
    onProgress,
  } = options;

  // Step 1: Classify the existing grid (building voxels get structural roles)
  onProgress?.('Classifying voxels...');
  const classified = classifyGrid(grid);

  // Count classifications for metadata
  const classificationCounts: Record<string, number> = {};
  for (let i = 0; i < classified.classes.length; i++) {
    const cls = VoxelClass[classified.classes[i]] ?? 'UNKNOWN';
    classificationCounts[cls] = (classificationCounts[cls] ?? 0) + 1;
  }
  onProgress?.(`Classification: ${Object.entries(classificationCounts).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(', ')}`);

  // Step 2: Build GeoProjection for coordinate conversion
  const projection = new GeoProjection(
    coords.lat, coords.lng,
    resolution,
    Math.floor(grid.width / 2),   // grid center X
    Math.floor(grid.length / 2),  // grid center Z
    calibrationDx,
    calibrationDz,
  );

  // Step 3: Fetch enrichment data from APIs
  onProgress?.('Fetching scene enrichment data...');
  const enrichment = await enrichForScene(
    coords.lat, coords.lng, plotRadius,
    propertyFlags,
  );
  onProgress?.(`Enrichment: ${enrichment.trees.length} trees, ${enrichment.roads.length} roads, ${enrichment.fences.length} fences, ground=${enrichment.groundCover}`);
  if (capturedEnvironment) {
    onProgress?.(`Captured: ${capturedEnvironment.trees.length} trees, ${capturedEnvironment.roads.cells.size} road cells, ${capturedEnvironment.vehicles.length} vehicles`);
  }

  // Step 4: Build environment
  onProgress?.('Building environment...');
  const blockContext: BlockContext = {
    groundCover: enrichment.groundCover,
  };

  const envStats = {
    treesPlaced: 0,
    roadsPlaced: 0,
    fencesPlaced: 0,
    groundFilled: 0,
  };

  // 4a. Fill ground layer — use captured ground materials when available
  const groundBlock = resolveBlock(VoxelClass.GROUND_GRASS, blockContext);
  const capturedRoadCells = capturedEnvironment?.roads.cells;
  for (let z = 0; z < grid.length; z++) {
    for (let x = 0; x < grid.width; x++) {
      // Determine ground Y from heightmap if available
      let groundYGrid = 0;
      if (terrainHeightmap && options.heightmapWidth && options.heightmapLength) {
        const hmX = Math.floor(x * options.heightmapWidth / grid.width);
        const hmZ = Math.floor(z * options.heightmapLength / grid.length);
        if (hmX >= 0 && hmX < options.heightmapWidth && hmZ >= 0 && hmZ < options.heightmapLength) {
          groundYGrid = Math.round(terrainHeightmap[hmZ * options.heightmapWidth + hmX] * resolution);
        }
      }

      const y = Math.max(0, groundYGrid);
      if (y >= grid.height || grid.get(x, y, z) !== 'minecraft:air') continue;

      const key = `${x},${z}`;
      // Use captured road cell positions for road block placement
      if (capturedRoadCells?.has(key)) {
        if (writeWithPriority(grid, classified.classes, x, y, z,
          capturedEnvironment!.roads.surfaceBlock, VoxelClass.GROUND_ROAD)) {
          envStats.roadsPlaced++;
        }
      } else {
        if (writeWithPriority(grid, classified.classes, x, y, z, groundBlock, VoxelClass.GROUND_GRASS)) {
          envStats.groundFilled++;
        }
      }
    }
  }
  onProgress?.(`Ground: ${envStats.groundFilled} blocks filled`);

  // 4b. Place roads
  const roadBlock = resolveBlock(VoxelClass.GROUND_ROAD, blockContext);
  const sidewalkBlock = resolveBlock(VoxelClass.GROUND_SIDEWALK, blockContext);
  for (const road of enrichment.roads) {
    // Project road nodes to grid coordinates
    const gridPoints: { x: number; z: number }[] = [];
    for (const node of road.nodes) {
      const gp = projection.toGridXZ(node.lat, node.lng);
      if (projection.isInBounds(gp.x, gp.z, grid.width, grid.length)) {
        gridPoints.push(gp);
      }
    }
    if (gridPoints.length < 2) continue;

    // Rasterize road centerline with width
    const roadWidth = Math.max(1, Math.round(road.width * resolution));
    const rasterized = rasterizeLine(gridPoints, roadWidth, grid.width, grid.length);

    for (const pt of rasterized) {
      if (writeWithPriority(grid, classified.classes, pt.x, 0, pt.z, roadBlock, VoxelClass.GROUND_ROAD)) {
        envStats.roadsPlaced++;
      }
    }

    // Add sidewalks on both sides (1 block wider than road)
    const sidewalkRaster = rasterizeLine(gridPoints, roadWidth + 2, grid.width, grid.length);
    for (const pt of sidewalkRaster) {
      // Only place sidewalk where road wasn't placed (edges)
      writeWithPriority(grid, classified.classes, pt.x, 0, pt.z, sidewalkBlock, VoxelClass.GROUND_SIDEWALK);
    }
  }

  // 4c. Place paths
  const pathBlock = resolveBlock(VoxelClass.GROUND_PATH, blockContext);
  for (const path of enrichment.paths) {
    const gridPoints: { x: number; z: number }[] = [];
    for (const node of path.nodes) {
      const gp = projection.toGridXZ(node.lat, node.lng);
      if (projection.isInBounds(gp.x, gp.z, grid.width, grid.length)) {
        gridPoints.push(gp);
      }
    }
    if (gridPoints.length < 2) continue;

    const pathWidth = Math.max(1, Math.round(path.width * resolution));
    const rasterized = rasterizeLine(gridPoints, pathWidth, grid.width, grid.length);
    for (const pt of rasterized) {
      writeWithPriority(grid, classified.classes, pt.x, 0, pt.z, pathBlock, VoxelClass.GROUND_PATH);
    }
  }

  // 4d. Place fences
  const fenceBlock = resolveBlock(VoxelClass.FENCE, blockContext);
  for (const fence of enrichment.fences) {
    const gridPoints: { x: number; z: number }[] = [];
    for (const node of fence.nodes) {
      const gp = projection.toGridXZ(node.lat, node.lng);
      if (projection.isInBounds(gp.x, gp.z, grid.width, grid.length)) {
        gridPoints.push(gp);
      }
    }
    if (gridPoints.length < 2) continue;

    const rasterized = rasterizeLine(gridPoints, 1, grid.width, grid.length);
    for (const pt of rasterized) {
      // Fence posts at ground+1
      if (writeWithPriority(grid, classified.classes, pt.x, 1, pt.z, fenceBlock, VoxelClass.FENCE)) {
        envStats.fencesPlaced++;
      }
    }
  }

  // 4e. Place trees (using direct grid.set — trees are multi-block structures
  // that write leaves+logs, so we check building bounds before placing)
  const { buildingBounds: bb } = classified;
  for (const tree of enrichment.trees) {
    const gp = projection.toGridXZ(tree.lat, tree.lng);
    if (!projection.isInBounds(gp.x, gp.z, grid.width, grid.length)) continue;

    // Skip trees that would overlap with building bounds (with 2-block margin)
    if (gp.x >= bb.minX - 2 && gp.x <= bb.maxX + 2 &&
        gp.z >= bb.minZ - 2 && gp.z <= bb.maxZ + 2) continue;

    // Determine ground Y
    let treeY = 1; // default: on top of ground block
    if (terrainHeightmap && options.heightmapWidth && options.heightmapLength) {
      const hmX = Math.floor(gp.x * options.heightmapWidth / grid.width);
      const hmZ = Math.floor(gp.z * options.heightmapLength / grid.length);
      if (hmX >= 0 && hmX < options.heightmapWidth && hmZ >= 0 && hmZ < options.heightmapLength) {
        treeY = Math.max(1, Math.round(terrainHeightmap[hmZ * options.heightmapWidth + hmX] * resolution) + 1);
      }
    }

    if (treeY >= grid.height - tree.height - 5) continue; // skip if too tall for grid

    // Place tree trunk and canopy directly
    // Simple tree: log trunk + leaf canopy (mirrors structures.ts placeTree pattern)
    const trunkBlock = treeTypeToLog(tree.species);
    const leafBlock = treeTypeToLeaves(tree.species);

    // Trunk
    for (let y = treeY; y < treeY + tree.height && y < grid.height; y++) {
      grid.set(gp.x, y, gp.z, trunkBlock);
    }

    // Canopy — simple sphere of leaves around top of trunk
    const canopyY = treeY + tree.height;
    const canopyR = Math.max(2, Math.min(3, Math.floor(tree.height / 2)));
    for (let dy = -1; dy <= canopyR; dy++) {
      const layerR = dy < canopyR - 1 ? canopyR : canopyR - 1; // taper at top
      for (let dx = -layerR; dx <= layerR; dx++) {
        for (let dz = -layerR; dz <= layerR; dz++) {
          // Spherical check
          if (dx * dx + dy * dy + dz * dz > (canopyR + 0.5) * (canopyR + 0.5)) continue;
          const lx = gp.x + dx, ly = canopyY + dy, lz = gp.z + dz;
          if (grid.inBounds(lx, ly, lz) && grid.get(lx, ly, lz) === 'minecraft:air') {
            grid.set(lx, ly, lz, leafBlock);
          }
        }
      }
    }
    envStats.treesPlaced++;
  }
  onProgress?.(`Trees: ${envStats.treesPlaced} placed, Roads: ${envStats.roadsPlaced}, Fences: ${envStats.fencesPlaced}`);

  // 4f. Place pool if detected
  if (enrichment.hasPool) {
    // Place south of building center, if space available
    const poolX = Math.floor(grid.width / 2) - 2;
    const poolZ = bb.maxZ + 3;
    const poolW = 5, poolL = 7;
    if (poolZ + poolL < grid.length && poolX >= 0 && poolX + poolW < grid.width) {
      for (let z = poolZ; z < poolZ + poolL; z++) {
        for (let x = poolX; x < poolX + poolW; x++) {
          const isEdge = z === poolZ || z === poolZ + poolL - 1 || x === poolX || x === poolX + poolW - 1;
          const block = isEdge ? 'minecraft:smooth_stone' : 'minecraft:water';
          const cls = isEdge ? VoxelClass.GROUND_SIDEWALK : VoxelClass.WATER;
          writeWithPriority(grid, classified.classes, x, 0, z, block, cls);
        }
      }
      onProgress?.('Pool placed');
    }
  }

  // 4g. Place driveway if detected
  if (enrichment.hasDriveway) {
    const drivewayBlock = 'minecraft:smooth_stone';
    // Simple 3-wide strip from building front (minZ) to grid edge
    const driveX = Math.floor(grid.width / 2) - 1;
    for (let z = 0; z < bb.minZ; z++) {
      for (let dx = 0; dx < 3; dx++) {
        const x = driveX + dx;
        if (x >= 0 && x < grid.width) {
          writeWithPriority(grid, classified.classes, x, 0, z, drivewayBlock, VoxelClass.GROUND_PATH);
        }
      }
    }
  }

  return {
    grid,
    classified,
    meta: {
      classificationCounts,
      enrichment,
      envStats,
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Map tree species to Minecraft log block */
function treeTypeToLog(species: string): string {
  switch (species) {
    case 'spruce': return 'minecraft:spruce_log';
    case 'birch': return 'minecraft:birch_log';
    case 'dark_oak': return 'minecraft:dark_oak_log';
    case 'jungle': return 'minecraft:jungle_log';
    case 'acacia': return 'minecraft:acacia_log';
    case 'cherry': return 'minecraft:cherry_log';
    case 'mangrove': return 'minecraft:mangrove_log';
    default: return 'minecraft:oak_log';
  }
}

/** Map tree species to Minecraft leaves block */
function treeTypeToLeaves(species: string): string {
  switch (species) {
    case 'spruce': return 'minecraft:spruce_leaves';
    case 'birch': return 'minecraft:birch_leaves';
    case 'dark_oak': return 'minecraft:dark_oak_leaves';
    case 'jungle': return 'minecraft:jungle_leaves';
    case 'acacia': return 'minecraft:acacia_leaves';
    case 'cherry': return 'minecraft:cherry_leaves';
    case 'mangrove': return 'minecraft:mangrove_leaves';
    default: return 'minecraft:oak_leaves';
  }
}

/**
 * Rasterize a polyline as a strip of grid cells with given width.
 * Uses Bresenham's line algorithm between consecutive points,
 * dilated to the specified width.
 *
 * @param points     Ordered grid coordinate points
 * @param width      Strip width in grid cells
 * @param gridWidth  Grid X dimension for bounds checking
 * @param gridLength Grid Z dimension for bounds checking
 * @returns Unique set of grid cells covered by the strip
 */
function rasterizeLine(
  points: { x: number; z: number }[],
  width: number,
  gridWidth: number,
  gridLength: number,
): { x: number; z: number }[] {
  const result = new Map<string, { x: number; z: number }>();
  const halfW = Math.floor(width / 2);

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];

    // Bresenham's line algorithm
    let x0 = p0.x, z0 = p0.z;
    const x1 = p1.x, z1 = p1.z;
    const dx = Math.abs(x1 - x0);
    const dz = Math.abs(z1 - z0);
    const sx = x0 < x1 ? 1 : -1;
    const sz = z0 < z1 ? 1 : -1;
    let err = dx - dz;

    while (true) {
      // Dilate point by width
      for (let ddx = -halfW; ddx <= halfW; ddx++) {
        for (let ddz = -halfW; ddz <= halfW; ddz++) {
          const px = x0 + ddx;
          const pz = z0 + ddz;
          if (px >= 0 && px < gridWidth && pz >= 0 && pz < gridLength) {
            const key = `${px},${pz}`;
            if (!result.has(key)) {
              result.set(key, { x: px, z: pz });
            }
          }
        }
      }

      if (x0 === x1 && z0 === z1) break;
      const e2 = 2 * err;
      if (e2 > -dz) { err -= dz; x0 += sx; }
      if (e2 < dx) { err += dx; z0 += sz; }
    }
  }

  return Array.from(result.values());
}

/**
 * Expand a BlockGrid to larger XZ dimensions, centering the original content.
 * Creates a new grid with the building voxels copied to the center.
 * Extra space is filled with air (ready for environment enrichment).
 *
 * @param grid       Original BlockGrid
 * @param newWidth   Target width (must be >= grid.width)
 * @param newLength  Target length (must be >= grid.length)
 * @returns New expanded grid with original content centered
 */
export function expandGrid(
  grid: BlockGrid,
  newWidth: number,
  newLength: number,
): BlockGrid {
  if (newWidth <= grid.width && newLength <= grid.length) return grid;

  const w = Math.max(newWidth, grid.width);
  const l = Math.max(newLength, grid.length);
  const expanded = new BlockGrid(w, grid.height, l);

  // Offset to center original content in expanded grid
  const dx = Math.floor((w - grid.width) / 2);
  const dz = Math.floor((l - grid.length) / 2);

  // Copy all non-air blocks from original to expanded grid
  for (let y = 0; y < grid.height; y++) {
    for (let z = 0; z < grid.length; z++) {
      for (let x = 0; x < grid.width; x++) {
        const block = grid.get(x, y, z);
        if (block !== 'minecraft:air') {
          expanded.set(x + dx, y, z + dz, block);
        }
      }
    }
  }

  return expanded;
}
