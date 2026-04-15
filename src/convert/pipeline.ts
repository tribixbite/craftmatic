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
  'resolution' | 'mode' | 'fill' | 'recolor' | 'scene' | 'noGlaze' |
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

// ─── Phase Implementations (stubs — filled in subsequent steps) ─────────────
// Each phase is a no-op stub. Implementation follows in Steps 2-7 of the
// migration plan, one phase group at a time with sub-agent review.

// TODO: Step 2 — ANALYZE + GROUND_REMOVAL + INTERIOR_FILL
function phaseAnalyze(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}
function phaseGroundRemoval(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}
function phaseInteriorFill(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}

// TODO: Step 3 — GEOMETRY_SMOOTH + SURFACE_SMOOTH
function phaseGeometrySmooth(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}
function phaseSurfaceSmooth(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}

// TODO: Step 4 — WINDOW_GLAZE + COLOR_SMOOTH + ISOLATED_CLEANUP
function phaseWindowGlaze(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}
function phaseColorSmooth(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}
function phaseIsolatedCleanup(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}

// TODO: Step 5 — BUILDING_ISOLATION + VEGETATION_STRIP + CROP
function phaseBuildingIsolation(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}
function phaseVegetationStrip(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}
function phaseCrop(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}

// TODO: Step 6 — OSM_MASK + POST_MASK + FOOTPRINT_FILL + FOOTPRINT_FREEZE
function phaseOSMMask(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}
function phasePostMask(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}
function phaseFootprintFill(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}
function phaseFootprintFreeze(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}

// TODO: Step 7 — SEMANTIC_RECOLOR + FINAL_CLEANUP + SCENE_FEATURES + HEIGHT_CORRECT + SKY_REMAP
function phaseSemanticRecolor(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}
function phaseFinalCleanup(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}
function phaseSceneFeatures(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}
function phaseHeightCorrect(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}
function phaseSkyRemap(_grid: BlockGrid, _config: ResolvedConfig, _state: PipelineState, _log: LogFn): void {}
