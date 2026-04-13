/**
 * Barrel re-export for the mesh-filter pipeline.
 *
 * The pipeline is split into domain modules under `./mesh-filter/`.
 * This file re-exports everything so existing import sites are unaffected.
 */

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
} from './mesh-filter/spatial-footprint.js';

// Grid analysis, statistics, metrics
export {
  labelConnectedComponents, analyzeGrid,
} from './mesh-filter/analysis.js';
export type { BuildingTypology, FaceDirection, AnalysisResult } from './mesh-filter/analysis.js';

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
