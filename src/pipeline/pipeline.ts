/**
 * Top-level pipeline orchestrator — wires Stages 0 through 9.
 *
 * The function is pure-ish: it takes injected API clients + fetchers + model
 * scorers, runs the full flow, and returns a result object with bytes for each
 * artifact. Disk writes are the caller's job (scripts/build.ts).
 */

import type {
  BuildingContext,
  CaptureProfile,
  RefinedBuildingContext,
} from './context/types.js';
import type { ContextFetchers } from './context/resolver.js';
import {
  resolveContext,
  ContextInsufficientError,
} from './context/resolver.js';
import { refineContextWithTiles } from './context/classify.js';
import { lookupProfile } from './context/profile.js';
import type { CaptureProgressFn, SatEvidence, SvEvidence, TileEvidence } from './capture/types.js';
import { captureTiles } from './capture/tiles.js';
import { captureStreetView, type StreetViewFetchers } from './capture/streetview.js';
import { captureSatellite, type SatelliteFetcher } from './capture/satellite.js';
import { fuseEvidence } from './fusion/reconcile.js';
import type { JointEvidence } from './fusion/types.js';
import { synthesize, type SynthesisPath } from './synthesis/router.js';
import type { BuildingBRep } from './synthesis/brep.js';
import { exportPrintGlb } from './export/glb-print.js';
import { exportSceneGlb } from './export/glb-scene.js';
import { exportVoxel } from './export/voxel.js';
import { runObjectiveGates } from './verify/objective.js';
import { composeReport, contextInsufficientReport } from './verify/report.js';
import type { FullVerificationReport } from './verify/report.js';
import type { ModelFetchers, RenderRoundFn } from './verify/consensus.js';
import { scoreConsensus } from './verify/consensus.js';
import { createGridRenderRound } from './verify/default-render-round.js';
import { BlockGrid } from '../schem/types.js';
import { DEFAULT_VOXEL_RESOLUTION, DEFAULT_VOXEL_MAX_DIMENSION } from './voxel-defaults.js';

// ─── Input types ───────────────────────────────────────────────────────────

export interface PipelineFetchers {
  readonly context: ContextFetchers;
  readonly streetview: StreetViewFetchers;
  readonly satellite: SatelliteFetcher;
}

export interface RunPipelineOptions {
  readonly address: string;
  readonly apiKey: string;
  readonly projectRoot: string;
  readonly fetchers: PipelineFetchers;
  /** Optional: run VLM consensus scoring after objective gates.
   *  `renderRound` is optional — if omitted, the pipeline renders 4 default
   *  views (iso, front, top-down, cutaway) from the output voxel grid. */
  readonly consensus?: {
    readonly models: ModelFetchers;
    readonly renderRound?: RenderRoundFn;
    readonly references: readonly Uint8Array[];
    readonly maxRounds?: number;
  };
  /** Optional tile-capture timeout in ms (default 120000). */
  readonly tileTimeoutMs?: number;
  /**
   * Skip Stage 3 entirely — useful for tests and for addresses where we know
   * Google 3D Tiles will fail (e.g. coverage gaps in rural areas). Synthesis
   * routes to the cleaned-tiles fallback which builds from MBR dimensions.
   */
  readonly skipTiles?: boolean;
  /**
   * Pre-built `TileEvidence` to inject in place of Stage 3 capture. When
   * provided, Stage 3 is skipped and this evidence is used directly. Used
   * by `--tiles-glb` (load locally cached GLB) and tests. Mutually
   * exclusive with `skipTiles=true` semantically — if both are set, the
   * injected tiles win.
   */
  readonly injectedTiles?: TileEvidence;
  /** Optional progress callback forwarded across stages. */
  readonly onProgress?: CaptureProgressFn;
  /** Voxel-export tuning. Defaults to resolution=6 block/m, maxDimension=768.
   *  At resolution 6 a typical 90m tower produces a ~540-tall grid with
   *  ~1-3M wall voxels (surface mode). Bump for finer detail. */
  readonly voxel?: {
    readonly resolution?: number;
    readonly maxDimension?: number;
  };
}

// Re-exported from the leaf module so existing `from './pipeline.js'` importers
// keep working; new browser-reachable code should import from voxel-defaults.js.
export { DEFAULT_VOXEL_RESOLUTION, DEFAULT_VOXEL_MAX_DIMENSION };

export interface RunPipelineArtifacts {
  readonly printGlbBytes: ArrayBuffer;
  readonly sceneGlbBytes: ArrayBuffer;
  readonly voxelGrid: BlockGrid;
  readonly voxelBlockCount: number;
  readonly brep: BuildingBRep;
  readonly synthesisPath: SynthesisPath;
  readonly context: RefinedBuildingContext;
  readonly evidence: JointEvidence;
  readonly captures: {
    readonly tiles: TileEvidence | null;
    readonly sv: SvEvidence;
    readonly satellite: SatEvidence | null;
  };
}

export interface RunPipelineResult {
  readonly artifacts: RunPipelineArtifacts | null;
  readonly report: FullVerificationReport;
  readonly slug: string;
}

// ─── Main orchestrator ─────────────────────────────────────────────────────

export async function runPipeline(opts: RunPipelineOptions): Promise<RunPipelineResult> {
  const slug = slugify(opts.address);
  const progress = opts.onProgress ?? (() => { /* noop */ });

  // ── Stage 0-2: context ─────────────────────────────────────────────────
  let ctx: BuildingContext;
  try {
    ctx = await resolveContext(opts.address, opts.fetchers.context);
  } catch (e) {
    if (e instanceof ContextInsufficientError) {
      return { artifacts: null, slug, report: contextInsufficientReport(e.reason) };
    }
    throw e;
  }
  const profile: CaptureProfile = lookupProfile(ctx);

  // ── Stage 3: tile capture ──────────────────────────────────────────────
  let tiles: TileEvidence | null = null;
  if (opts.injectedTiles) {
    tiles = opts.injectedTiles;
    progress({ stage: 'tiles', message: 'using injected tiles', ratio: 1 });
  } else if (opts.skipTiles) {
    progress({ stage: 'tiles', message: 'skipped', ratio: 1 });
  } else {
    progress({ stage: 'tiles', message: 'capturing tiles…', ratio: 0 });
  try {
    tiles = await captureTiles({
      center: ctx.center,
      radiusM: profile.tiles.radiusM,
      errorTarget: profile.tiles.errorTarget,
      verticalBands: profile.tiles.verticalBands,
      cameraMode: profile.tiles.cameraMode,
      expectedHeightM: profile.tiles.expectedHeightM,
      rotationDeg: ctx.mbr.rotationDeg,
      apiKey: opts.apiKey,
      projectRoot: opts.projectRoot,
      timeoutMs: opts.tileTimeoutMs,
      onProgress: progress,
    });
    } catch (e) {
      // Tile capture failure is non-fatal — fallback path takes over.
      progress({ stage: 'tiles', message: `capture failed: ${(e as Error).message}`, ratio: 1 });
    }
  }

  // ── Post-3 shape refinement ────────────────────────────────────────────
  const refined: RefinedBuildingContext = tiles && tiles.heightmapWidth > 0
    ? refineContextWithTiles(ctx, {
        heightmap: tiles.heightmap,
        heightmapWidth: tiles.heightmapWidth,
        heightmapLength: tiles.heightmapLength,
      })
    : ({ ...ctx, __refined: true } as unknown as RefinedBuildingContext);

  // ── Stage 4: SV capture ────────────────────────────────────────────────
  progress({ stage: 'sv', message: 'capturing street view…', ratio: 0 });
  const sv: SvEvidence = await captureStreetView({
    ctx: refined,
    profile,
    fetchers: opts.fetchers.streetview,
    onProgress: progress,
  });

  // ── Stage 5: satellite ─────────────────────────────────────────────────
  progress({ stage: 'satellite', message: 'capturing satellite…', ratio: 0 });
  let sat: SatEvidence | null = null;
  try {
    sat = await captureSatellite({
      lat: refined.center.lat,
      lng: refined.center.lng,
      widthM: refined.mbr.widthM,
      depthM: refined.mbr.depthM,
      tiles,
      polygon: refined.polygon,
      profile,
      fetcher: opts.fetchers.satellite,
      onProgress: progress,
    });
  } catch (e) {
    progress({ stage: 'satellite', message: `failed: ${(e as Error).message}`, ratio: 1 });
  }

  // ── Stage 6: fusion ────────────────────────────────────────────────────
  progress({ stage: 'fusion', message: 'fusing evidence', ratio: 0 });
  const evidence = fuseEvidence({ ctx: refined, tiles, sv, sat });
  progress({ stage: 'fusion', message: 'done', ratio: 1 });

  // ── Stage 7: synthesis ─────────────────────────────────────────────────
  progress({ stage: 'synthesis', message: 'synthesizing B-rep', ratio: 0 });
  const { brep, path, meta } = synthesize(refined, evidence, tiles);
  progress({ stage: 'synthesis', message: `done (${path})`, ratio: 1 });

  // ── Stage 8: exports ───────────────────────────────────────────────────
  progress({ stage: 'export', message: 'print GLB (CSG)', ratio: 0 });
  const printResult = await exportPrintGlb(brep);
  progress({ stage: 'export', message: 'scene GLB', ratio: 0.4 });
  const sceneResult = await exportSceneGlb(brep, evidence);
  progress({ stage: 'export', message: 'voxelizing', ratio: 0.7 });
  const voxelResolution = opts.voxel?.resolution ?? DEFAULT_VOXEL_RESOLUTION;
  const voxelMaxDim = opts.voxel?.maxDimension ?? DEFAULT_VOXEL_MAX_DIMENSION;

  // Photogrammetry color transfer: only when we have tile GLB AND the
  // sliced synthesizer ran (it produces yScale/yShift). Decoded textures
  // give real per-voxel colour from the building's actual photo capture.
  type RecolorOpts = NonNullable<Parameters<typeof exportVoxel>[1]>['photogrammetryRecolor'];
  let photogrammetryRecolor: RecolorOpts;
  if (path === '7d-sliced' && tiles && meta.yScale && meta.yShift !== undefined && tiles.glbBytes.byteLength > 0) {
    try {
      const { parseGlbMeshesFull } = await import('./export/glb-writer.js');
      const primitives = parseGlbMeshesFull(tiles.glbBytes);
      photogrammetryRecolor = {
        primitives,
        yScale: meta.yScale,
        yShift: meta.yShift,
        maxDistanceM: 2.0,
      };
    } catch (e) {
      progress({
        stage: 'export',
        message: `recolor parse failed: ${(e as Error).message}`,
        ratio: 0.7,
      });
    }
  }

  const voxelResult = await exportVoxel(brep, {
    resolution: voxelResolution,
    maxDimension: voxelMaxDim,
    photogrammetryRecolor,
  });
  progress({ stage: 'export', message: 'done', ratio: 1 });

  // ── Stage 9a: objective gates ──────────────────────────────────────────
  progress({ stage: 'verify', message: 'objective gates', ratio: 0 });
  const objective = runObjectiveGates({
    positions: printResult.structuralPositions,
    indices: printResult.structuralIndices,
    targetPolygon: evidence.footprint.value,
    meshOrigin: refined.center,
    meshRotationDeg: refined.mbr.rotationDeg,
    expectedHeightM: evidence.heightM.value,
    grid: voxelResult.grid,
    voxelResolution,
  });
  progress({ stage: 'verify', message: 'done', ratio: 1 });

  // ── Stage 9b: consensus (only if objective passes + wired) ─────────────
  let consensus = undefined;
  if (objective.pass && opts.consensus) {
    progress({ stage: 'verify', message: 'consensus (VLM)', ratio: 0 });
    const renderRound = opts.consensus.renderRound ?? createGridRenderRound(voxelResult.grid);
    const result = await scoreConsensus({
      renderRound,
      references: opts.consensus.references,
      fetchers: opts.consensus.models,
      maxRounds: opts.consensus.maxRounds,
    });
    progress({
      stage: 'verify',
      message: `consensus ${result.status} (min=${result.min.toFixed(1)} med=${result.median.toFixed(1)})`,
      ratio: 1,
    });
    consensus = result;
  }

  const report = composeReport({ objective, consensus, evidence, ctx: refined, grid: voxelResult.grid, synthesisPath: path });

  return {
    slug,
    artifacts: {
      printGlbBytes: printResult.glbBytes,
      sceneGlbBytes: sceneResult.glbBytes,
      voxelGrid: voxelResult.grid,
      voxelBlockCount: voxelResult.blockCount,
      brep,
      synthesisPath: path,
      context: refined,
      evidence,
      captures: { tiles, sv, satellite: sat },
    },
    report,
  };
}

// ─── Slugify helper ────────────────────────────────────────────────────────

export function slugify(address: string): string {
  return address
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'address';
}
