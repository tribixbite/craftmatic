/**
 * Shared post-processing pipeline for voxelized BlockGrids.
 *
 * Pure orchestrator: imports existing functions from mesh-filter/,
 * semantic-palette.ts, etc. Zero Node.js APIs, zero I/O.
 * All external data (OSM polygon, SV colors, satellite) passed via config.
 *
 * Consumers:
 * - CLI (scripts/voxelize-glb.ts) — passes pre-fetched API data
 * - Browser (web/src/ui/tiles.ts) — skips API-dependent phases
 */

import { BlockGrid } from '../schem/types.js';
import type { AnalysisResult } from './mesh-filter/analysis.js';
import type { ExtractedEnvironment } from './mesh-filter/environment.js';
import type { SemanticPalette } from './semantic-palette.js';
import {
  analyzeGrid,
  removeGroundPlane, removeGroundPlaneAdaptive,
  morphClose3D, fillFacadeHoles, removeIsolatedVoxels,
  fillInteriorGaps, scanlineInteriorFill, clearOpenAirFill,
  smoothSurface, addPeakedRoof, regularizeFlatRoof,
  morphCloseFacadeAligned, detectCornices,
  flattenFacadesSetbackAware, flattenFacades,
  straightenFootprintEdges,
  fillFacadeVoids2D, fillFacadePlaneHoles,
  fillFacadeVoidsIterative, fillFacadeStripes,
  smoothRareBlocks, constrainPalette, modeFilter3D,
  smoothDarkBlocks, smoothFacadeColors, clusterFacadePalette,
  smoothRoofPlane, boostPhotogrammetrySaturation,
  removeSmallComponents, removeArtifactComponents,
  isolateTallestStructure, severByHeightGradient,
  watershedIsolate, isolatePrimaryBuilding, removeThinPillars,
  cropToRect, cropToAABB,
  maskToFootprint, alignOSMToFootprint, maskToFootprintAligned,
  enforceFootprintPolygon,
  detectCourtyardVoids,
  glazeDarkWindows, glazeReflectiveWindows,
  injectSyntheticWindows, detectAndRegularizeWindows,
  stripVegetation, extractEnvironmentPositions,
  replaceWithCleanFeatures,
  snapshotGridBlocks, restoreGridBlocks,
} from './mesh-filter.js';
import { applySemanticPalette } from './semantic-palette.js';

// ─── Phase Enum ─────────────────────────────────────────────────────────────

/**
 * Named pipeline phases, ordered by execution sequence.
 * Each phase maps to one or more pure function calls from mesh-filter/.
 * Used for progress reporting, pause/resume, and selective skip.
 */
export enum PipelinePhase {
  /** Auto-detect building properties via analyzeGrid() */
  ANALYZE            = 'analyze',
  /** Remove terrain below building */
  GROUND_REMOVAL     = 'ground-removal',
  /** Mask to OSM footprint polygon (requires coords + osmPolygon) */
  OSM_MASK           = 'osm-mask',
  /** Tower isolation + component cleanup */
  BUILDING_ISOLATION = 'building-isolation',
  /** 3D masked dilation + scanline fill + courtyard detect */
  INTERIOR_FILL      = 'interior-fill',
  /** Remove tree/bush blocks, extract environment positions */
  VEGETATION_STRIP   = 'vegetation-strip',
  /** Center/AABB crop + ground cleanup */
  CROP               = 'crop',
  /** morphClose3D + facade close + hole fill + edge straighten */
  GEOMETRY_SMOOTH    = 'geometry-smooth',
  /** smoothSurface + flattenFacades + facade voids */
  SURFACE_SMOOTH     = 'surface-smooth',
  /** Dark window glazing + reflective + synthetic */
  WINDOW_GLAZE       = 'window-glaze',
  /** smoothDarkBlocks + saturation boost + modeFilter3D + facade/roof smooth */
  COLOR_SMOOTH       = 'color-smooth',
  /** Remove single-neighbor voxels */
  ISOLATED_CLEANUP   = 'isolated-cleanup',
  /** Apply SemanticPalette (OSM colour/material + SV + satellite) */
  SEMANTIC_RECOLOR   = 'semantic-recolor',
  /** Re-mask to sharpen edges blurred by morph/filter */
  POST_MASK          = 'post-mask',
  /** Clip columns added by morphClose/filter outside original footprint */
  FOOTPRINT_FREEZE   = 'footprint-freeze',
  /** Remove blue/cyan skylight contamination */
  SKY_REMAP          = 'sky-remap',
  /** Fill empty interior columns from OSM polygon */
  FOOTPRINT_FILL     = 'footprint-fill',
  /** Component cleanup + pillar removal + roof regularization + remaps */
  FINAL_CLEANUP      = 'final-cleanup',
  /** Replace features + window regularization */
  SCENE_FEATURES     = 'scene-features',
  /** Extrude truncated buildings */
  HEIGHT_CORRECT     = 'height-correct',
}

// ─── Config Interface ───────────────────────────────────────────────────────

/**
 * All inputs needed to run the post-processing pipeline.
 * External data (OSM polygon, SV colors, satellite) passed as optional fields.
 * The pipeline never fetches anything — callers provide pre-fetched data.
 */
export interface PipelineConfig {
  // ── Core parameters ──
  /** Blocks per meter (1 = standard, 2-3 = high detail) */
  resolution: number;
  /** Voxelization mode that produced the grid */
  mode: 'solid' | 'surface';

  // ── Pipeline behavior flags ──
  /** Use generic mode (skip rectangular-specific processing). Auto-detected if omitted. */
  generic?: boolean;
  /** Enable interior fill (default true) */
  fill?: boolean;
  /** Enable semantic recoloring (requires semanticPalette) */
  recolor?: boolean;
  /**
   * Aggressive recolor: override ALL non-glass blocks with palette colors (not just GRAY_FAMILY).
   * Use for buildings where photogrammetry bakes in dark textures obscuring the true color.
   */
  forceRecolor?: boolean;
  /** Enable scene mode (feature replacement + enrichment data extraction) */
  scene?: boolean;
  /** Skip window glazing */
  noGlaze?: boolean;
  /** Skip OSM masking even if polygon provided */
  noOsm?: boolean;
  /** Skip post-mask re-sharpening */
  noPostMask?: boolean;
  /** Skip geometry isolation fallback */
  noIsolate?: boolean;
  /** Enable peaked roof synthesis */
  peakedRoof?: boolean;
  /** Enable height truncation correction */
  heightCorrect?: boolean;

  // ── Tuning parameters ──
  /** Smooth rare blocks below this frequency (0 = skip, 0.02 = default) */
  smoothPct?: number;
  /** Mode filter passes (default auto from analysis) */
  modePasses?: number;
  /** Crop radius in blocks (0 = skip) */
  cropRadius?: number;
  /** Whether to use AABB crop instead of circular (from analysis.recommended) */
  useAABBCrop?: boolean;
  /** Minimum component size for cleanup (0 = auto) */
  cleanMinSize?: number;
  /** OSM mask dilation in meters (default 3) */
  maskDilate?: number;
  /** Block remaps to apply at end: fromBlock -> toBlock */
  remaps?: Map<string, string>;

  // ── External data (pre-fetched by caller) ──
  /** Building coordinates (WGS84) */
  coords?: { lat: number; lng: number };
  /** ENU horizontal rotation angle from GLB orientation (radians) */
  enuHorizontalAngle?: number;
  /** OSM building polygon (lat/lon vertices, pre-fetched) */
  osmPolygon?: Array<{ lat: number; lon: number }>;
  /** OSM building tags (for semantic palette resolution) */
  osmTags?: Record<string, string>;
  /** Building alignment from OSM MBR */
  buildingAlignment?: {
    rotationDeg: number;
    mbrWidth: number;
    mbrDepth: number;
  };
  /** Explicit OSM ID (type + ID) for targeted query bypass */
  osmId?: { type: string; id: number };
  /** Resolved semantic palette (wall/roof materials from OSM + SV + satellite) */
  semanticPalette?: SemanticPalette;
  /** Known building height in meters (for height correction) */
  knownHeightM?: number;
  /** Captured environment data (tree/road/vehicle positions from photogrammetry) */
  capturedEnvironment?: ExtractedEnvironment;
  /** Override analysis result (skip re-analysis) */
  precomputedAnalysis?: AnalysisResult;

  // ── Phases to skip (for partial pipeline runs) ──
  /** Set of phases to skip entirely */
  skipPhases?: Set<PipelinePhase>;
}

// ─── State Interface ────────────────────────────────────────────────────────

/**
 * Tracks pipeline progress through phases. Allows pause/resume.
 * Browser can yield between phases for UI responsiveness.
 */
export interface PipelineState {
  /** Current phase being executed (or last completed) */
  currentPhase: PipelinePhase;
  /** Index of current phase in execution order (0-based) */
  phaseIndex: number;
  /** Total number of phases that will execute (excluding skipped) */
  totalPhases: number;
  /** Analysis result (populated after ANALYZE phase) */
  analysis: AnalysisResult | null;
  /** Whether OSM mask was successfully applied */
  osmMaskApplied: boolean;
  /** Saved OSM polygon for post-mask and footprint fill */
  osmPolygon: Array<{ lat: number; lon: number }> | null;
  /** OSM tags captured during masking */
  osmTags: Record<string, string>;
  /** Environment positions (populated during VEGETATION_STRIP for scene mode) */
  envPositions: ExtractedEnvironment | undefined;
  /** Saved 2D footprint bitmap for footprint freeze */
  savedFootprint: Uint8Array | null;
  /** Grid width when footprint was saved (for validation) */
  savedFootprintWidth: number;
  /** Grid length when footprint was saved */
  savedFootprintLength: number;
  /** Whether post-mask was applied (determines footprint freeze) */
  postMaskApplied: boolean;
  /** Computed isComplexShape flag (from analysis) */
  isComplexShape: boolean;
  /** Per-phase statistics */
  phaseStats: Map<PipelinePhase, { blocksChanged: number; elapsedMs: number }>;
  /** Whether pipeline completed all phases */
  completed: boolean;
}

// ─── Callback Interface ─────────────────────────────────────────────────────

/**
 * Callbacks for pipeline progress reporting and browser UI integration.
 */
export interface PipelineCallbacks {
  /** Called at the start of each phase */
  onPhaseStart?: (phase: PipelinePhase, state: PipelineState) => void;
  /** Called at the end of each phase with stats */
  onPhaseEnd?: (phase: PipelinePhase, blocksChanged: number, state: PipelineState) => void;
  /** Called for log messages (replaces console.log in CLI) */
  onLog?: (message: string) => void;
  /**
   * Called between phases — return a Promise to yield to browser UI.
   * Browser: () => new Promise(r => setTimeout(r, 0))
   * CLI: omit or no-op
   */
  onYield?: () => Promise<void> | void;
}

// ─── Phase Execution Order ──────────────────────────────────────────────────

/** Canonical phase ordering — matches the CLI pipeline sequence */
const PHASE_ORDER: PipelinePhase[] = [
  PipelinePhase.ANALYZE,
  PipelinePhase.GROUND_REMOVAL,
  PipelinePhase.OSM_MASK,
  PipelinePhase.BUILDING_ISOLATION,
  PipelinePhase.INTERIOR_FILL,
  PipelinePhase.VEGETATION_STRIP,
  PipelinePhase.CROP,
  PipelinePhase.GEOMETRY_SMOOTH,
  PipelinePhase.SURFACE_SMOOTH,
  PipelinePhase.WINDOW_GLAZE,
  PipelinePhase.COLOR_SMOOTH,
  PipelinePhase.ISOLATED_CLEANUP,
  PipelinePhase.SEMANTIC_RECOLOR,
  PipelinePhase.POST_MASK,
  PipelinePhase.FOOTPRINT_FREEZE,
  PipelinePhase.SKY_REMAP,
  PipelinePhase.FOOTPRINT_FILL,
  PipelinePhase.FINAL_CLEANUP,
  PipelinePhase.SCENE_FEATURES,
  PipelinePhase.HEIGHT_CORRECT,
];

// ─── Internal types ─────────────────────────────────────────────────────────

/** Config with defaults resolved — used internally by phase executors */
interface ResolvedConfig extends Required<Pick<PipelineConfig,
  'resolution' | 'mode' | 'fill' | 'recolor' | 'forceRecolor' | 'scene' | 'noGlaze' |
  'noOsm' | 'noPostMask' | 'noIsolate' | 'peakedRoof' | 'heightCorrect' |
  'smoothPct' | 'modePasses' | 'cropRadius' | 'useAABBCrop' | 'cleanMinSize' |
  'maskDilate' | 'enuHorizontalAngle'
>> {
  generic: boolean;
  coords: PipelineConfig['coords'];
  osmPolygon: PipelineConfig['osmPolygon'];
  osmTags: PipelineConfig['osmTags'];
  buildingAlignment: PipelineConfig['buildingAlignment'];
  osmId: PipelineConfig['osmId'];
  semanticPalette: PipelineConfig['semanticPalette'];
  knownHeightM: PipelineConfig['knownHeightM'];
  capturedEnvironment: PipelineConfig['capturedEnvironment'];
  precomputedAnalysis: PipelineConfig['precomputedAnalysis'];
  remaps: Map<string, string>;
  skipPhases: Set<PipelinePhase>;
}

/** Log helper type */
type LogFn = (message: string) => void;

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Run the full post-processing pipeline on a pre-voxelized BlockGrid.
 *
 * Pure function: no I/O, no API calls, no Node.js APIs.
 * All external data (OSM polygon, SV colors, satellite) provided via config.
 * Grid is mutated in-place for performance (avoids cloning 500K+ block grids).
 *
 * @param grid       Pre-voxelized BlockGrid (mutated in-place)
 * @param config     Pipeline configuration and external data
 * @param callbacks  Progress/log callbacks (optional)
 * @returns Final pipeline state with analysis, stats, and environment data
 */
export async function runPipeline(
  grid: BlockGrid,
  config: PipelineConfig,
  callbacks?: PipelineCallbacks,
): Promise<PipelineState> {
  const log: LogFn = callbacks?.onLog ?? (() => {});
  const rc = resolveConfig(config);

  // Determine which phases to execute
  const activePhasesAll = PHASE_ORDER.filter(p => !rc.skipPhases.has(p));

  // Initialize state
  const state: PipelineState = {
    currentPhase: activePhasesAll[0] ?? PipelinePhase.ANALYZE,
    phaseIndex: 0,
    totalPhases: activePhasesAll.length,
    analysis: rc.precomputedAnalysis ?? null,
    osmMaskApplied: false,
    osmPolygon: rc.osmPolygon ?? null,
    osmTags: rc.osmTags ?? {},
    envPositions: rc.capturedEnvironment,
    savedFootprint: null,
    savedFootprintWidth: 0,
    savedFootprintLength: 0,
    postMaskApplied: false,
    isComplexShape: false,
    phaseStats: new Map(),
    completed: false,
  };

  // Execute each phase in order
  for (let i = 0; i < activePhasesAll.length; i++) {
    const phase = activePhasesAll[i];
    state.currentPhase = phase;
    state.phaseIndex = i;

    const countBefore = grid.countNonAir();
    const t0 = performance.now();

    callbacks?.onPhaseStart?.(phase, state);

    // Execute phase
    executePhase(grid, phase, rc, state, log);

    const elapsed = performance.now() - t0;
    const countAfter = grid.countNonAir();
    const blocksChanged = Math.abs(countAfter - countBefore);

    state.phaseStats.set(phase, { blocksChanged, elapsedMs: elapsed });
    callbacks?.onPhaseEnd?.(phase, blocksChanged, state);

    // Yield between phases for browser UI responsiveness
    if (callbacks?.onYield) {
      await callbacks.onYield();
    }
  }

  state.completed = true;
  return state;
}

// ─── Config Resolution ──────────────────────────────────────────────────────

/** Apply defaults to create a fully-resolved config */
function resolveConfig(config: PipelineConfig): ResolvedConfig {
  return {
    resolution: config.resolution,
    mode: config.mode,
    generic: config.generic ?? false,
    fill: config.fill ?? true,
    recolor: config.recolor ?? false,
    forceRecolor: config.forceRecolor ?? false,
    scene: config.scene ?? false,
    noGlaze: config.noGlaze ?? false,
    noOsm: config.noOsm ?? false,
    noPostMask: config.noPostMask ?? false,
    noIsolate: config.noIsolate ?? false,
    peakedRoof: config.peakedRoof ?? false,
    heightCorrect: config.heightCorrect ?? false,
    smoothPct: config.smoothPct ?? 0.02,
    modePasses: config.modePasses ?? 2,
    cropRadius: config.cropRadius ?? 0,
    useAABBCrop: config.useAABBCrop ?? false,
    cleanMinSize: config.cleanMinSize ?? 0,
    maskDilate: config.maskDilate ?? 3,
    enuHorizontalAngle: config.enuHorizontalAngle ?? 0,
    coords: config.coords,
    osmPolygon: config.osmPolygon,
    osmTags: config.osmTags,
    buildingAlignment: config.buildingAlignment,
    osmId: config.osmId,
    semanticPalette: config.semanticPalette,
    knownHeightM: config.knownHeightM,
    capturedEnvironment: config.capturedEnvironment,
    precomputedAnalysis: config.precomputedAnalysis,
    remaps: config.remaps ?? new Map(),
    skipPhases: config.skipPhases ?? new Set(),
  };
}

// ─── Phase Dispatcher ───────────────────────────────────────────────────────

/**
 * Execute a single pipeline phase. Each phase calls existing pure functions
 * from the mesh-filter/ modules. No I/O or API calls.
 */
function executePhase(
  grid: BlockGrid,
  phase: PipelinePhase,
  config: ResolvedConfig,
  state: PipelineState,
  log: LogFn,
): void {
  switch (phase) {
    case PipelinePhase.ANALYZE:
      phaseAnalyze(grid, config, state, log);
      break;
    case PipelinePhase.GROUND_REMOVAL:
      phaseGroundRemoval(grid, config, state, log);
      break;
    case PipelinePhase.OSM_MASK:
      phaseOSMMask(grid, config, state, log);
      break;
    case PipelinePhase.BUILDING_ISOLATION:
      phaseBuildingIsolation(grid, config, state, log);
      break;
    case PipelinePhase.INTERIOR_FILL:
      phaseInteriorFill(grid, config, state, log);
      break;
    case PipelinePhase.VEGETATION_STRIP:
      phaseVegetationStrip(grid, config, state, log);
      break;
    case PipelinePhase.CROP:
      phaseCrop(grid, config, state, log);
      break;
    case PipelinePhase.GEOMETRY_SMOOTH:
      phaseGeometrySmooth(grid, config, state, log);
      break;
    case PipelinePhase.SURFACE_SMOOTH:
      phaseSurfaceSmooth(grid, config, state, log);
      break;
    case PipelinePhase.WINDOW_GLAZE:
      phaseWindowGlaze(grid, config, state, log);
      break;
    case PipelinePhase.COLOR_SMOOTH:
      phaseColorSmooth(grid, config, state, log);
      break;
    case PipelinePhase.ISOLATED_CLEANUP:
      phaseIsolatedCleanup(grid, config, state, log);
      break;
    case PipelinePhase.SEMANTIC_RECOLOR:
      phaseSemanticRecolor(grid, config, state, log);
      break;
    case PipelinePhase.POST_MASK:
      phasePostMask(grid, config, state, log);
      break;
    case PipelinePhase.FOOTPRINT_FREEZE:
      phaseFootprintFreeze(grid, config, state, log);
      break;
    case PipelinePhase.SKY_REMAP:
      phaseSkyRemap(grid, config, state, log);
      break;
    case PipelinePhase.FOOTPRINT_FILL:
      phaseFootprintFill(grid, config, state, log);
      break;
    case PipelinePhase.FINAL_CLEANUP:
      phaseFinalCleanup(grid, config, state, log);
      break;
    case PipelinePhase.SCENE_FEATURES:
      phaseSceneFeatures(grid, config, state, log);
      break;
    case PipelinePhase.HEIGHT_CORRECT:
      phaseHeightCorrect(grid, config, state, log);
      break;
  }
}

// ─── Phase Implementations ──────────────────────────────────────────────────

function phaseAnalyze(grid: BlockGrid, config: ResolvedConfig, state: PipelineState, log: LogFn): void {
  if (state.analysis) {
    // Precomputed analysis provided — just compute derived state
    log(`Analysis: using precomputed (confidence=${state.analysis.confidence.toFixed(1)})`);
  } else {
    state.analysis = analyzeGrid(grid);
    log(`Analysis: ${state.analysis.typology} | confidence=${state.analysis.confidence.toFixed(1)} | ${state.analysis.estimatedWidthM}x${state.analysis.estimatedHeightM}x${state.analysis.estimatedDepthM}m`);
  }

  const a = state.analysis;
  // Compute isComplexShape from analysis
  state.isComplexShape = (a.rectangularity < 0.85) || a.hasSetbacks;

  // Apply auto recommendations to config (same logic as CLI lines 748-781)
  const rec = a.recommended;
  // v300: confidence >= 3.5 forces building mode
  if (a.confidence >= 3.5 && rec.generic) rec.generic = false;
  // Only override defaults (not explicit user settings)
  if (config.generic === false && rec.generic) config.generic = rec.generic;
  if (config.smoothPct === 0.02) config.smoothPct = rec.smoothPct;
  if (config.modePasses === 2) config.modePasses = Math.max(rec.modePasses, 2);
  if (config.cropRadius === 0 && rec.cropRadius > 0) {
    const aabb = a.centralAABB;
    const vol = (aabb.maxX - aabb.minX + 1) * (aabb.maxY - aabb.minY + 1) * (aabb.maxZ - aabb.minZ + 1);
    if (vol > 100) config.cropRadius = rec.cropRadius;
  }
  if (config.cleanMinSize === 0 && rec.cleanMinSize > 0) config.cleanMinSize = rec.cleanMinSize;
  // Merge auto remaps (user remaps take precedence)
  for (const [from, to] of rec.remaps) {
    if (!config.remaps.has(from)) config.remaps.set(from, to);
  }

  // Apply AABB crop if recommended
  if (rec.useAABBCrop || config.useAABBCrop) {
    const aabb = a.centralAABB;
    const cropped = cropToAABB(grid, aabb.minX, aabb.maxX, aabb.minZ, aabb.maxZ, 2);
    if (cropped > 0) log(`AABB crop: ${cropped} blocks removed`);
  }
}

function phaseGroundRemoval(grid: BlockGrid, config: ResolvedConfig, _state: PipelineState, log: LogFn): void {
  if (config.mode === 'surface') {
    const { removed } = removeGroundPlane(grid, 1);
    if (removed > 0) log(`Ground plane: ${removed} terrain blocks removed`);
  }
  const adaptive = removeGroundPlaneAdaptive(grid);
  if (adaptive > 0) log(`Ground plane (adaptive): ${adaptive} blocks removed`);
}

function phaseOSMMask(grid: BlockGrid, config: ResolvedConfig, state: PipelineState, log: LogFn): void {
  if (!state.osmPolygon || !config.coords || config.noOsm) return;
  if (state.osmPolygon.length < 3) return;

  const dilateBlocks = Math.round(config.maskDilate * config.resolution);
  const snapshot = snapshotGridBlocks(grid);

  try {
    maskToFootprint(
      grid, state.osmPolygon,
      config.coords.lat, config.coords.lng,
      dilateBlocks, config.resolution, config.enuHorizontalAngle,
    );
    const remaining = grid.countNonAir();

    if (remaining < snapshot.count * 0.1 && snapshot.count > 0) {
      // Direct mask removed too much — try auto-alignment
      restoreGridBlocks(grid, snapshot);
      const alignment = alignOSMToFootprint(
        grid, state.osmPolygon,
        config.coords.lat, config.coords.lng,
        config.resolution, config.enuHorizontalAngle,
        40, 0.15,
        !!config.buildingAlignment,
      );
      if (alignment) {
        maskToFootprintAligned(
          grid, state.osmPolygon,
          config.coords.lat, config.coords.lng,
          dilateBlocks, config.resolution, config.enuHorizontalAngle,
          alignment.dx, alignment.dz,
        );
        const alignRemaining = grid.countNonAir();
        if (alignRemaining >= snapshot.count * 0.1) {
          log(`OSM mask (auto-aligned dx=${alignment.dx} dz=${alignment.dz} IoU=${alignment.iou.toFixed(2)}): ${snapshot.count - alignRemaining} removed`);
          state.osmMaskApplied = true;
          return;
        }
        restoreGridBlocks(grid, snapshot);
      }
      log(`OSM mask: alignment failed, using geometry isolation`);
    } else {
      log(`OSM mask: ${snapshot.count - remaining} blocks removed, ${remaining} remaining`);
      state.osmMaskApplied = true;
    }
  } catch (err) {
    restoreGridBlocks(grid, snapshot);
    log(`OSM mask failed: ${(err as Error).message}`);
  }
}

function phaseBuildingIsolation(grid: BlockGrid, config: ResolvedConfig, state: PipelineState, log: LogFn): void {
  const analysis = state.analysis;

  // Tower isolation — skip for setback buildings
  if (!analysis?.hasSetbacks) {
    const isolated = isolateTallestStructure(grid, 0.75, 5);
    if (isolated > 0) log(`Tower isolation: ${isolated} blocks removed`);
  }

  // Component cleanup — resolution-aware threshold (500m³ at 1x)
  const compMinSize = Math.round(500 * Math.pow(config.resolution, 3));
  const cleaned = removeSmallComponents(grid, compMinSize);
  if (cleaned > 0) log(`Pre-fill cleanup: ${cleaned} blocks removed (<${compMinSize} voxels)`);

  // Density + distance artifact cleanup
  const artifacts = removeArtifactComponents(grid, 0.1, 1.5);
  if (artifacts > 0) log(`Artifact cleanup: ${artifacts} blocks removed`);

  // 3-tier isolation when OSM mask failed
  if (!state.osmMaskApplied && !config.noIsolate) {
    const tier1 = isolatePrimaryBuilding(grid);
    if (tier1 > 0) log(`Isolation tier 1: ${tier1} blocks removed`);

    const tier2 = severByHeightGradient(grid, 3, 200);
    if (tier2 > 0) log(`Isolation tier 2: ${tier2} blocks severed`);

    // Tier 3: Watershed with safe revert
    const snapshot = snapshotGridBlocks(grid);
    watershedIsolate(grid, 4);
    const remaining = grid.countNonAir();
    if (remaining < snapshot.count * 0.50 && snapshot.count > 0) {
      restoreGridBlocks(grid, snapshot);
      log(`Isolation tier 3: reverted (would remove >50%)`);
    } else if (snapshot.count - remaining > 0) {
      log(`Isolation tier 3: ${snapshot.count - remaining} blocks removed`);
    }
  }
}

function phaseInteriorFill(grid: BlockGrid, config: ResolvedConfig, _state: PipelineState, log: LogFn): void {
  if (!config.fill) return;

  const totalCells = grid.width * grid.height * grid.length;
  const nonAirCount = grid.countNonAir();
  const fill3D = nonAirCount / totalCells;

  if (fill3D > 0.60) {
    log(`Skipping fill (3D density ${(fill3D * 100).toFixed(0)}% > 60%)`);
    return;
  }

  // Density-adaptive dilation — target physical gap size in meters
  const targetMeters = fill3D < 0.30 ? 4 : fill3D < 0.50 ? 3 : 2;
  const dilation = config.generic
    ? 1  // Generic mode: conservative to avoid merging structures
    : Math.max(1, Math.round(targetMeters * config.resolution));

  const filledSet = new Set<number>();
  const filled = fillInteriorGaps(grid, dilation, config.resolution, filledSet);
  log(`Interior fill (dilation=${dilation}): ${filled} voxels filled (3D density ${(fill3D * 100).toFixed(0)}%)`);

  // Sky exposure — remove fill in open-air spaces (courtyards, setbacks)
  const clearance = config.generic ? 5 : Math.round(5 * config.resolution);
  const openAirCleared = clearOpenAirFill(grid, 'minecraft:smooth_stone', clearance, filledSet);
  if (openAirCleared > 0) log(`Open-air fill cleared: ${openAirCleared} blocks`);

  // Scanline interior fill — catches thin gaps that dilation missed
  if (!config.generic) {
    const scanFilled = scanlineInteriorFill(grid, filledSet);
    if (scanFilled > 0) log(`Scanline interior fill: ${scanFilled} voxels`);
  }

  // Courtyard void detection — undo fills in architectural voids
  const courtyardVoids = detectCourtyardVoids(grid);
  if (courtyardVoids.size > 0) {
    let courtyardCleared = 0;
    for (const key of courtyardVoids) {
      const comma = key.indexOf(',');
      const cx = parseInt(key.substring(0, comma), 10);
      const cz = parseInt(key.substring(comma + 1), 10);
      for (let y = 0; y < grid.height; y++) {
        const idx = (y * grid.length + cz) * grid.width + cx;
        if (filledSet.has(idx) && grid.get(cx, y, cz) !== 'minecraft:air') {
          grid.set(cx, y, cz, 'minecraft:air');
          filledSet.delete(idx);
          courtyardCleared++;
        }
      }
    }
    if (courtyardCleared > 0) {
      log(`Courtyard detection: ${courtyardVoids.size} void columns, ${courtyardCleared} blocks cleared`);
    }
  }
}

function phaseVegetationStrip(grid: BlockGrid, config: ResolvedConfig, state: PipelineState, log: LogFn): void {
  // Extract environment positions BEFORE stripping vegetation
  if (config.scene && config.coords && !state.envPositions) {
    state.envPositions = extractEnvironmentPositions(grid, state.analysis?.groundPlaneY ?? 0);
    log(`Environment extraction: ${state.envPositions.trees.length} trees, ${state.envPositions.roads.cells.size} road cells`);
  }

  if (config.mode === 'surface') {
    const stripped = stripVegetation(grid);
    if (stripped > 0) log(`Vegetation strip: ${stripped} blocks removed`);
  }
}

function phaseCrop(grid: BlockGrid, config: ResolvedConfig, state: PipelineState, log: LogFn): void {
  const analysis = state.analysis;
  if (config.cropRadius > 0 && !analysis?.isPartialCapture) {
    // Dry-run: check if crop would destroy >95% of blocks (off-center building)
    const cx = Math.floor(grid.width / 2);
    const cz = Math.floor(grid.length / 2);
    const r = config.cropRadius;
    let inside = 0, outside = 0;
    for (let y = 0; y < grid.height; y++) {
      for (let z = 0; z < grid.length; z++) {
        for (let x = 0; x < grid.width; x++) {
          if (grid.get(x, y, z) === 'minecraft:air') continue;
          if (Math.abs(x - cx) > r || Math.abs(z - cz) > r) outside++;
          else inside++;
        }
      }
    }
    if (inside < (inside + outside) * 0.05 && (inside + outside) > 500) {
      log(`Skipping crop (only ${inside}/${inside + outside} blocks inside — building offset)`);
    } else {
      const cropped = cropToRect(grid, config.cropRadius);
      if (cropped > 0) log(`Rect crop: ${cropped} blocks removed (half-width ${config.cropRadius})`);
    }
  }

  // Ground plane subtraction for generic + no-fill
  if (config.mode === 'surface' && config.generic && !config.fill) {
    const { removed } = removeGroundPlane(grid, 1);
    if (removed > 0) log(`Ground plane: ${removed} blocks removed`);
  }

  // Smooth rare/noisy blocks
  if (config.smoothPct > 0) {
    const smoothed = smoothRareBlocks(grid, config.smoothPct);
    if (smoothed > 0) log(`Smoothed ${smoothed} rare blocks (${(config.smoothPct * 100).toFixed(1)}%)`);
  }

  // Save 2D footprint bitmap BEFORE morphClose for later freeze
  const { width: gw, height: gh, length: gl } = grid;
  state.savedFootprint = new Uint8Array(gw * gl);
  state.savedFootprintWidth = gw;
  state.savedFootprintLength = gl;
  for (let z = 0; z < gl; z++) {
    for (let x = 0; x < gw; x++) {
      for (let y = 0; y < gh; y++) {
        if (grid.get(x, y, z) !== 'minecraft:air') {
          state.savedFootprint[z * gw + x] = 1;
          break;
        }
      }
    }
  }
}

function phaseGeometrySmooth(grid: BlockGrid, _config: ResolvedConfig, state: PipelineState, log: LogFn): void {
  const isComplex = state.isComplexShape;
  const analysis = state.analysis;

  // Morph close — profile-aware for complex shapes
  if (isComplex) {
    const profile = analysis?.heightProfile ?? 'uniform';
    const fractions: Record<string, number> = {
      tapered: 0.35, stepped: 0.40, domed: 0.30, uniform: 0.50,
    };
    const fraction = fractions[profile] ?? 0.30;
    const maxY = Math.max(10, Math.round(grid.height * fraction));
    const closed = morphClose3D(grid, 1, maxY);
    if (closed > 0) log(`Morph close (r=1, maxY=${maxY}, profile=${profile}): ${closed} holes filled`);
  } else {
    const closed = morphClose3D(grid, 1);
    if (closed > 0) log(`Morph close (r=1): ${closed} holes filled`);
  }

  // Facade-aligned morph close
  const facadeClosed = morphCloseFacadeAligned(grid, 2);
  if (facadeClosed > 0) log(`Facade morph close (r=2): ${facadeClosed} gaps filled`);

  // Facade hole fill — complex=3 neighbors, regular=4
  const ms = isComplex ? 3 : 4;
  const holeFilled = fillFacadeHoles(grid, ms, 1);
  if (holeFilled > 0) log(`Facade hole fill: ${holeFilled} voids patched (${ms}+ neighbors)`);

  // Facade stripe repair
  const stripes = fillFacadeStripes(grid);
  if (stripes > 0) log(`Facade stripes: ${stripes} filled`);

  // Iterative facade void fill
  const voids = fillFacadeVoidsIterative(grid, 5);
  if (voids > 0) log(`Facade voids: ${voids} filled`);

  // Edge straightening — skip for complex shapes
  if (!isComplex) {
    const straightened = straightenFootprintEdges(grid, 2, 2);
    if (straightened > 0) log(`Edge straightening: ${straightened} blocks adjusted`);
  }
}

function phaseSurfaceSmooth(grid: BlockGrid, config: ResolvedConfig, state: PipelineState, log: LogFn): void {
  const isComplex = state.isComplexShape;
  const analysis = state.analysis;

  // Surface smoothing — profile-aware roof cutoff
  let roofCutoff: number;
  if (isComplex) {
    const profile = analysis?.heightProfile ?? 'uniform';
    const fractions: Record<string, number> = {
      tapered: 0.15, stepped: 0.50, domed: 0.25, uniform: 0.40,
    };
    roofCutoff = Math.round(grid.height * (fractions[profile] ?? 0.30));
  } else {
    roofCutoff = Math.round(grid.height * 0.60);
  }
  const surfaceSmoothed = smoothSurface(grid, roofCutoff, true);
  if (surfaceSmoothed > 0) log(`Surface smoothing: ${surfaceSmoothed} protrusions removed (below Y=${roofCutoff})`);

  // Facade flattening — rectangular buildings only
  if (!isComplex && analysis?.isRectangular) {
    const corniceYs = detectCornices(grid, 2, true);
    if (corniceYs.size > 0) {
      const snapped = flattenFacadesSetbackAware(grid, corniceYs, 1, config.resolution);
      if (snapped > 0) log(`Setback-aware facade flattening: ${snapped} voxels snapped`);
    } else {
      const snapped = flattenFacades(grid, 1, roofCutoff);
      if (snapped > 0) log(`Facade flattening: ${snapped} voxels snapped`);
    }
  }

  // Facade void sealing (2D flood-fill)
  const sealed = fillFacadeVoids2D(grid);
  if (sealed > 0) {
    log(`Facade void sealing: ${sealed} enclosed voids filled`);
    // Second hole fill pass — scanline creates new anchor points
    const holeFilled2 = fillFacadeHoles(grid, 4);
    if (holeFilled2 > 0) log(`Facade hole fill pass 2: ${holeFilled2} patched`);
  }

  // Facade plane holes — bounded air pockets <= 25 blocks
  const planeFilled = fillFacadePlaneHoles(grid, 25);
  if (planeFilled > 0) log(`Facade plane holes: ${planeFilled} air pockets filled`);
}

function phaseWindowGlaze(grid: BlockGrid, config: ResolvedConfig, state: PipelineState, log: LogFn): void {
  if (config.mode !== 'surface' || config.noGlaze) return;

  let glazed = glazeDarkWindows(grid, config.resolution, true);
  if (glazed > 0) log(`Window glazing: ${glazed} dark blocks → glass`);

  const reflective = glazeReflectiveWindows(grid, config.resolution);
  if (reflective > 0) log(`Reflective windows: ${reflective} blocks → glass`);
  glazed += reflective;

  const injected = injectSyntheticWindows(grid, glazed, config.resolution);
  if (injected > 0) log(`Synthetic windows: ${injected} blocks`);

  // Store glazed count on state for use by color smoothing
  (state as PipelineState & { _glazedCount?: number })._glazedCount = glazed;
}

function phaseColorSmooth(grid: BlockGrid, config: ResolvedConfig, state: PipelineState, log: LogFn): void {
  // Skip color smoothing when recolor is active (semantic recolor handles colors)
  if (config.recolor) {
    log(`Color smoothing: SKIPPED (recolor active)`);
    return;
  }

  // Smooth dark shadow artifacts
  const darkSmoothed = smoothDarkBlocks(grid);
  if (darkSmoothed > 0) log(`Dark block smoothing: ${darkSmoothed} shadow artifacts replaced`);

  // Saturation boost
  const satBoosted = boostPhotogrammetrySaturation(grid);
  if (satBoosted > 0) log(`Saturation boost: ${satBoosted} blocks recolored`);

  // Mode filter 3D — floor at 2 passes, cap at 3
  const passes = Math.min(3, Math.max(config.modePasses, 2));
  const modeSmoothed = modeFilter3D(grid, passes, 1);
  if (modeSmoothed > 0) log(`Mode filter: ${modeSmoothed} blocks homogenized (${passes} passes)`);

  // Post-filter morphClose — skip for complex shapes
  if (!state.isComplexShape) {
    const closed = morphClose3D(grid, 1);
    if (closed > 0) log(`Morph close post-filter: ${closed} pockmarks healed`);
  }

  // Facade color coherence (Lab-weighted)
  const facadeSmoothed = smoothFacadeColors(grid);
  if (facadeSmoothed > 0) log(`Facade color smoothing: ${facadeSmoothed} outliers replaced`);

  // K-means facade palette clustering
  const paletteReplaced = clusterFacadePalette(grid, 4);
  if (paletteReplaced > 0) log(`Facade palette clustering: ${paletteReplaced} blocks (K-means k=4)`);

  // Roof plane smoothing
  const roofSmoothed = smoothRoofPlane(grid);
  if (roofSmoothed > 0) log(`Roof plane smoothing: ${roofSmoothed} blocks replaced`);
}

function phaseIsolatedCleanup(grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, log: LogFn): void {
  const isolated = removeIsolatedVoxels(grid, 1);
  if (isolated > 0) log(`Isolated voxel removal: ${isolated} single-block artifacts removed`);
}

function phaseSemanticRecolor(grid: BlockGrid, config: ResolvedConfig, _state: PipelineState, log: LogFn): void {
  if (!config.recolor || !config.semanticPalette) return;

  const palette = config.semanticPalette;
  // Apply aggressive mode when forceRecolor is set — overrides all non-glass blocks.
  if (config.forceRecolor) palette.aggressive = true;
  if (palette.wallBlocks.length > 0 || palette.wallColor || palette.roofBlocks) {
    const recolored = applySemanticPalette(grid, palette);
    const mode = palette.aggressive ? 'all blocks' : 'gray blocks';
    log(`Semantic recolor: ${recolored} ${mode} recolored (${palette.source})`);
  }
}

function phasePostMask(grid: BlockGrid, config: ResolvedConfig, state: PipelineState, log: LogFn): void {
  if (!state.osmPolygon || !config.coords || config.noOsm || config.noPostMask) return;

  const dilateBlocks = Math.round(config.maskDilate * config.resolution);
  const snapshot = snapshotGridBlocks(grid);

  try {
    maskToFootprint(
      grid, state.osmPolygon,
      config.coords.lat, config.coords.lng,
      dilateBlocks, config.resolution, config.enuHorizontalAngle,
    );
    const remaining = grid.countNonAir();

    if (remaining < snapshot.count * 0.60 && snapshot.count > 0) {
      restoreGridBlocks(grid, snapshot);
      log(`Post-mask: reverted (would remove ${((1 - remaining / snapshot.count) * 100).toFixed(0)}%)`);
    } else {
      state.postMaskApplied = true;
      log(`Post-mask: ${snapshot.count - remaining} blocks removed, ${remaining} remaining`);
    }
  } catch (err) {
    restoreGridBlocks(grid, snapshot);
    log(`Post-mask failed: ${(err as Error).message}`);
  }
}

function phaseFootprintFreeze(grid: BlockGrid, _config: ResolvedConfig, state: PipelineState, log: LogFn): void {
  // Skip when post-mask was applied — polygon is more authoritative
  if (!state.savedFootprint || state.postMaskApplied) return;

  const { width: gw, height: gh, length: gl } = grid;
  // Validate footprint dimensions still match
  if (state.savedFootprintWidth !== gw || state.savedFootprintLength !== gl) return;

  let clipped = 0;
  for (let z = 0; z < gl; z++) {
    for (let x = 0; x < gw; x++) {
      if (state.savedFootprint[z * gw + x]) continue;
      for (let y = 0; y < gh; y++) {
        if (grid.get(x, y, z) !== 'minecraft:air') {
          grid.set(x, y, z, 'minecraft:air');
          clipped++;
        }
      }
    }
  }
  if (clipped > 0) log(`Footprint freeze: ${clipped} blocks clipped (expansion from morph/filter)`);
}

function phaseSkyRemap(grid: BlockGrid, config: ResolvedConfig, _state: PipelineState, log: LogFn): void {
  const skyReplacements = new Map<string, string>([
    ['minecraft:light_blue_terracotta', 'minecraft:light_gray_concrete'],
    ['minecraft:cyan_terracotta', 'minecraft:stone'],
    ['minecraft:light_blue_concrete', 'minecraft:light_gray_concrete'],
    ['minecraft:cyan_concrete', 'minecraft:stone'],
  ]);

  // When a semantic palette is active, protect its wall blocks from being remapped.
  // e.g. --force-recolor --building-colour blue intentionally uses light_blue_terracotta as
  // wall blocks — don't remap it. But still remap non-palette cyan blocks (e.g. cyan_terracotta
  // from satellite roof analysis on a chrome-coloured building).
  for (const block of config.semanticPalette?.wallBlocks ?? []) {
    // wallBlocks may or may not include 'minecraft:' prefix — normalise before delete
    const key = block.startsWith('minecraft:') ? block : `minecraft:${block}`;
    skyReplacements.delete(key);
  }

  if (skyReplacements.size === 0) {
    log('Sky palette: SKIPPED (all candidates are intentional palette blocks)');
    return;
  }
  const constrained = constrainPalette(grid, skyReplacements);
  if (constrained > 0) log(`Sky palette: ${constrained} blue/cyan blocks remapped`);
}

function phaseFootprintFill(grid: BlockGrid, config: ResolvedConfig, state: PipelineState, log: LogFn): void {
  if (!state.osmPolygon || !config.coords || config.noOsm) return;

  // Compute dominant wall/roof materials for fill
  const wallDom = computeDominantMaterial(grid, 'wall');
  const roofDom = computeDominantMaterial(grid, 'roof');

  const { filled } = enforceFootprintPolygon(
    grid, state.osmPolygon,
    config.coords.lat, config.coords.lng,
    config.resolution, config.enuHorizontalAngle,
    wallDom, roofDom,
  );
  if (filled > 0) log(`Footprint fill: ${filled} voxels added to empty interior columns`);
}

function phaseFinalCleanup(grid: BlockGrid, config: ResolvedConfig, _state: PipelineState, log: LogFn): void {
  // Peaked roof synthesis
  if (config.peakedRoof) {
    const roofDom = computeDominantMaterial(grid, 'roof');
    const added = addPeakedRoof(grid, roofDom);
    if (added > 0) log(`Peaked roof: ${added} blocks added`);
  }

  // Component cleanup — resolution-aware threshold
  const baseThreshold = config.mode === 'surface' ? 500 : config.cleanMinSize;
  const threshold = Math.round(baseThreshold * Math.pow(config.resolution, 3));
  if (threshold > 0) {
    const cleaned = removeSmallComponents(grid, threshold);
    if (cleaned > 0) log(`Component cleanup: ${cleaned} blocks removed (<${threshold} voxels)`);
  }

  // Pillar removal
  const pillars = removeThinPillars(grid);
  if (pillars > 0) log(`Pillar removal: ${pillars} blocks removed`);

  // Flat roof regularization
  const roofFixed = regularizeFlatRoof(grid);
  if (roofFixed > 0) log(`Roof regularization: ${roofFixed} blocks fixed`);

  // Custom block remaps
  if (config.remaps.size > 0) {
    const remapped = constrainPalette(grid, config.remaps);
    if (remapped > 0) log(`Custom remap: ${remapped} blocks remapped (${config.remaps.size} rules)`);
  }
}

function phaseSceneFeatures(grid: BlockGrid, config: ResolvedConfig, state: PipelineState, log: LogFn): void {
  // Replace photogrammetry features with clean MC equivalents
  if (config.scene && state.envPositions) {
    const treePalette: Array<'oak' | 'birch' | 'dark_oak'> = ['oak', 'birch', 'dark_oak'];
    const replaced = replaceWithCleanFeatures(
      grid, state.envPositions, treePalette, 'grass', state.analysis?.groundPlaneY ?? 0,
    );
    log(`Features: ${replaced.trees} trees, ${replaced.roads} road cells, ${replaced.vehicles} vehicles`);
  }

  // Window & door regularization
  if (config.scene) {
    const win = detectAndRegularizeWindows(grid, state.analysis?.groundPlaneY ?? 0);
    log(`Windows: ${win.windowsRegularized} regularized, doors: ${win.doorsPlaced}`);
  }
}

function phaseHeightCorrect(grid: BlockGrid, config: ResolvedConfig, state: PipelineState, log: LogFn): void {
  if (!config.heightCorrect) return;

  // Determine known height: explicit override > OSM tags
  let knownHeightM = config.knownHeightM ?? 0;
  if (knownHeightM <= 0 && state.osmTags) {
    const osmH = state.osmTags['height'] || state.osmTags['building:height'];
    if (osmH) {
      const parsed = parseFloat(osmH);
      if (!isNaN(parsed) && parsed > 0) knownHeightM = parsed;
    }
    if (knownHeightM <= 0) {
      const levels = state.osmTags['building:levels'];
      if (levels) {
        const n = parseInt(levels, 10);
        if (!isNaN(n) && n > 0) knownHeightM = n * 3.5;
      }
    }
  }

  if (knownHeightM <= 0) {
    log(`Height correction: no height data available`);
    return;
  }

  // Find highest occupied Y
  let maxVoxelY = 0;
  for (let y = grid.height - 1; y >= 0; y--) {
    let found = false;
    for (let z = 0; z < grid.length && !found; z++) {
      for (let x = 0; x < grid.width && !found; x++) {
        if (grid.get(x, y, z) !== 'minecraft:air') { maxVoxelY = y; found = true; }
      }
    }
    if (found) break;
  }

  const voxelHeightM = (maxVoxelY + 1) / config.resolution;
  const ratio = voxelHeightM / knownHeightM;

  if (ratio < 0.6) {
    const targetBlocks = Math.round(knownHeightM * config.resolution);
    const layers = targetBlocks - (maxVoxelY + 1);
    log(`Height correction: ${voxelHeightM.toFixed(0)}m / ${knownHeightM.toFixed(0)}m (${(ratio * 100).toFixed(0)}%), +${layers} layers`);
    extrudeBuilding(grid, layers, maxVoxelY);
  } else {
    log(`Height correction: not needed (${(ratio * 100).toFixed(0)}%)`);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extrude building by duplicating the top cross-section upward */
function extrudeBuilding(grid: BlockGrid, layers: number, topY: number): void {
  if (layers <= 0) return;
  const newHeight = topY + 1 + layers;
  grid.expandHeight(newHeight);
  for (let dy = 1; dy <= layers; dy++) {
    const destY = topY + dy;
    for (let z = 0; z < grid.length; z++) {
      for (let x = 0; x < grid.width; x++) {
        const block = grid.get(x, topY, z);
        if (block !== 'minecraft:air') grid.set(x, destY, z, block);
      }
    }
  }
}

/** Compute the dominant material in a zone (wall = middle 60%, roof = top 20%) */
function computeDominantMaterial(grid: BlockGrid, zone: 'wall' | 'roof'): string {
  const counts = new Map<string, number>();
  const { width, height, length } = grid;

  for (let x = 0; x < width; x++) {
    for (let z = 0; z < length; z++) {
      let topY = -1;
      for (let y = height - 1; y >= 0; y--) {
        if (grid.get(x, y, z) !== 'minecraft:air') { topY = y; break; }
      }
      if (topY < 0) continue;

      if (zone === 'roof') {
        const b = grid.get(x, topY, z);
        if (b !== 'minecraft:air') counts.set(b, (counts.get(b) ?? 0) + 1);
      } else {
        for (let y = 0; y < topY; y++) {
          const b = grid.get(x, y, z);
          if (b !== 'minecraft:air') counts.set(b, (counts.get(b) ?? 0) + 1);
        }
      }
    }
  }

  let best = 'minecraft:smooth_stone';
  let bestCount = 0;
  for (const [block, count] of counts) {
    if (count > bestCount) { best = block; bestCount = count; }
  }
  return best;
}
