/**
 * Barrel re-export for the mesh-filter pipeline.
 *
 * The pipeline is split into domain modules under `./mesh-filter/`.
 * This file re-exports everything so existing import sites are unaffected.
 */

import { BlockGrid } from '../schem/types.js';

// Re-export vegetation blocks from voxelizer (single source of truth)
export { VEGETATION_BLOCKS } from './voxelizer.js';

// ─── Grid Snapshot Utilities ──────────────────────────────────────────────────

/**
 * Snapshot of all non-air blocks in a grid, stored as flat index → block name.
 * Used by the pipeline to revert destructive operations (OSM masking, watershed)
 * when the result is worse than the input.
 */
export interface GridSnapshot {
  /** Flat index → block state for all non-air voxels at snapshot time */
  readonly blocks: Map<number, string>;
  /** Grid dimensions at snapshot time (for validation) */
  readonly width: number;
  readonly height: number;
  readonly length: number;
  /** Number of non-air blocks at snapshot time */
  readonly count: number;
}

/**
 * Capture a snapshot of all non-air blocks in the grid.
 * Uses numeric flat indices (y*L+z)*W+x for O(1) restore lookups,
 * unlike the previous string-key "x,y,z" pattern that required parsing.
 */
export function snapshotGridBlocks(grid: BlockGrid): GridSnapshot {
  const { width, height, length } = grid;
  const blocks = new Map<number, string>();
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const b = grid.get(x, y, z);
        if (b !== 'minecraft:air') {
          blocks.set((y * length + z) * width + x, b);
        }
      }
    }
  }
  return { blocks, width, height, length, count: blocks.size };
}

/**
 * Restore all blocks from a snapshot, overwriting current grid state.
 * Validates that grid dimensions match the snapshot to prevent silent corruption.
 */
export function restoreGridBlocks(grid: BlockGrid, snapshot: GridSnapshot): void {
  if (grid.width !== snapshot.width || grid.height !== snapshot.height || grid.length !== snapshot.length) {
    throw new Error(
      `Grid dimensions changed since snapshot: ` +
      `${snapshot.width}x${snapshot.height}x${snapshot.length} → ` +
      `${grid.width}x${grid.height}x${grid.length}`
    );
  }
  const { width, height, length } = grid;
  // First: clear any blocks added AFTER the snapshot was taken
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * length + z) * width + x;
        if (!snapshot.blocks.has(idx) && grid.get(x, y, z) !== 'minecraft:air') {
          grid.set(x, y, z, 'minecraft:air');
        }
      }
    }
  }
  // Then: restore all blocks from the snapshot
  // Index formula: idx = (y * length + z) * width + x
  for (const [idx, block] of snapshot.blocks) {
    const x = idx % width;
    const z = Math.floor(idx / width) % length;
    const y = Math.floor(idx / (width * length));
    grid.set(x, y, z, block);
  }
}

// Internal helpers (constants, grid snapshots, block color utilities)
export {
  AIR, H_DIRS, FACES6,
  snapshotGrid, readSnap,
  getBlockLab, blockLuminance, findBrightNeighborMode,
} from './mesh-filter/_internal.js';

// Pre-voxelization mesh capture filtering
export { filterMeshesByHeight, trimSparseBottomLayers } from './mesh-filter/mesh-capture.js';

// Facade geometry operations (detection, alignment, plane ops, edge straightening)
export {
  flattenFacades, morphCloseFacadeAligned, detectCornices,
  flattenFacadesSetbackAware, straightenFootprintEdges,
  fillFacadeVoids2D, fillFacadePlaneHoles,
  fillFacadeVoidsIterative, fillFacadeStripes,
} from './mesh-filter/geometry-facade.js';

// Core geometry operations (morphology, fill, cleanup, roof)
export {
  morphClose3D, erodeSurfaceBumps, fillFacadeHoles,
  removeIsolatedVoxels, fillInteriorGaps, scanlineInteriorFill,
  clearOpenAirFill, smoothSurface, rectangularize, addPeakedRoof,
  regularizeFlatRoof,
} from './mesh-filter/geometry-core.js';

// Color smoothing, palette, mode filter
export {
  smoothRareBlocks, constrainPalette, modeFilter3D,
  smoothDarkBlocks, smoothFacadeColors, clusterFacadePalette,
  smoothRoofPlane, homogenizeFacadesByFace, consolidateBlockPalette,
  boostPhotogrammetrySaturation,
  MODEFILTER_PROTECTED, PALETTE_PROTECTED,
} from './mesh-filter/color.js';
export type { FacadeDir } from './mesh-filter/color.js';

// Connected-component analysis & isolation
export {
  removeSmallComponents, removeArtifactComponents,
  isolateTallestStructure, severByHeightGradient, watershedIsolate,
  isolatePrimaryBuilding, severStreetFurniture, removeThinPillars,
} from './mesh-filter/spatial-components.js';

// Crop, mask, footprint enforcement
export {
  cropToCenter, cropToRect, cropToAABB, removeGroundPlane,
  removeGroundPlaneAdaptive,
  maskToFootprint, alignOSMToFootprint, maskToFootprintAligned,
  enforceFootprintPolygon,
  // Shared helpers (exported for testing and reuse)
  projectPolygonToBlocks, rasterizePolygonToBitmap, rasterizePolygonToSet,
  morphCloseBitmap, CoordinateBitmapImpl,
} from './mesh-filter/spatial-footprint.js';

// Grid analysis, statistics, metrics
export {
  labelConnectedComponents, analyzeGrid,
} from './mesh-filter/analysis.js';
export type { BuildingTypology, FaceDirection, AnalysisResult } from './mesh-filter/analysis.js';

// Courtyard/atrium void detection
export { detectCourtyardVoids } from './mesh-filter/courtyard-detect.js';

// Window detection, glass operations
export {
  glazeDarkWindows, glazeReflectiveWindows,
  injectSyntheticWindows, detectAndRegularizeWindows,
} from './mesh-filter/windows.js';

// Environment: vegetation, roads, vehicles, entry paths
export {
  placeEntryPath, stripVegetation,
  extractEnvironmentPositions, replaceWithCleanFeatures,
  VEGETATION_BLOCKS_POST, ROAD_BLOCKS, VEHICLE_BLOCKS,
} from './mesh-filter/environment.js';
export type {
  EntryPathAnalysis, DetectedTree, DetectedRoad,
  DetectedVehicle, ExtractedEnvironment,
} from './mesh-filter/environment.js';
