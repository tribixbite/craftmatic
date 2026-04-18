/**
 * Browser entry point into the pipeline — post-tile-capture.
 *
 * The Node `captureTiles()` function boots its own TilesRenderer + DRACO
 * loader; the browser already has those in `web/src/engine/tile-capture.ts`.
 * This entry accepts a Three.js `Group` that the browser has already populated
 * with captured meshes and handles:
 *
 *   • mesh bbox measurement + heightmap rasterization
 *   • GLB encoding via the shared writer
 *   • building `TileEvidence`
 *   • the rest of the pipeline (refine → fusion → synthesis → exports → verify)
 *
 * Nothing in this module imports `sharp`, `node:fs`, `3d-tiles-renderer`, or
 * the DRACO loader. Safe to bundle for the browser.
 */

import type * as THREE from 'three';

import { refineContextWithTiles } from './context/classify.js';
import type { BuildingContext, CaptureProfile, RefinedBuildingContext } from './context/types.js';
import type {
  CaptureProgressFn,
  SatEvidence,
  SvEvidence,
  TileEvidence,
} from './capture/types.js';
import {
  BboxAccumulator,
  addPositionsToHeightmap,
  createHeightmapState,
  isHeightTruncated,
  normaliseHeightmap,
} from './capture/heightmap.js';
import { extractMeshInputs } from './capture/mesh-extract.js';
import { captureStreetView, type StreetViewFetchers } from './capture/streetview.js';
import { captureSatellite, type SatelliteFetcher } from './capture/satellite.js';
import { fuseEvidence } from './fusion/reconcile.js';
import type { JointEvidence } from './fusion/types.js';
import { synthesize, type SynthesisPath } from './synthesis/router.js';
import type { BuildingBRep } from './synthesis/brep.js';
import { buildGlb } from './export/glb-writer.js';
import { exportPrintGlb } from './export/glb-print.js';
import { exportSceneGlb } from './export/glb-scene.js';
import { exportVoxel } from './export/voxel.js';
import { runObjectiveGates } from './verify/objective.js';
import type { FullVerificationReport } from './verify/report.js';
import { composeReport } from './verify/report.js';
import { scoreConsensus, type ModelFetchers, type RenderRoundFn } from './verify/consensus.js';

// ─── Post-capture evidence builder ─────────────────────────────────────────

export interface BrowserCaptureInput {
  /** Three.js group populated with captured tile meshes (after matrixWorld baked into geometry). */
  readonly group: THREE.Group;
  readonly expectedHeightM: number;
}

export interface BrowserCaptureOutput {
  readonly evidence: TileEvidence;
  readonly meshes: THREE.Mesh[];
}

/**
 * Convert a browser-captured Three.js group into a `TileEvidence`. The group's
 * meshes must already have their `matrixWorld` baked into geometry vertices
 * (same convention as `scripts/tiles-headless.ts` at line 460, and now
 * `captureTiles()`'s `extractMeshesInto`).
 */
export async function buildTileEvidenceFromGroup(
  input: BrowserCaptureInput,
): Promise<BrowserCaptureOutput> {
  const bboxAcc = new BboxAccumulator();
  const meshes: THREE.Mesh[] = [];
  input.group.traverse(obj => {
    const m = obj as THREE.Mesh;
    if (m.isMesh) {
      meshes.push(m);
      const geo = m.geometry as THREE.BufferGeometry;
      const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (pos) bboxAcc.addPositions(new Float32Array(pos.array));
    }
  });
  const measuredBbox = bboxAcc.get() ?? { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

  const hmState = createHeightmapState(measuredBbox, 1);
  if (hmState) {
    for (const mesh of meshes) {
      const geo = mesh.geometry as THREE.BufferGeometry;
      const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (pos) addPositionsToHeightmap(hmState, new Float32Array(pos.array));
    }
    normaliseHeightmap(hmState);
  }

  const truncated = isHeightTruncated(measuredBbox, input.expectedHeightM);
  const meshInputs = await extractMeshInputs(meshes, { encodeTextures: false });
  const glbBytes = buildGlb(meshInputs, { generator: 'craftmatic-browser-tiles' });

  const evidence: TileEvidence = {
    glbPath: null,
    glbBytes,
    heightmap: hmState?.heights ?? new Float32Array(0),
    heightmapWidth: hmState?.width ?? 0,
    heightmapLength: hmState?.length ?? 0,
    measuredBbox: {
      min: { x: measuredBbox.minX, y: measuredBbox.minY, z: measuredBbox.minZ },
      max: { x: measuredBbox.maxX, y: measuredBbox.maxY, z: measuredBbox.maxZ },
    },
    truncated,
    meshCount: meshes.length,
    noCoverage: meshes.length < 3,
  };

  return { evidence, meshes };
}

// ─── Browser-wide pipeline (post-capture) ──────────────────────────────────

export interface BrowserPipelineInput {
  /** The BuildingContext resolved by the browser (via resolveContext with
   *  browser-compatible fetchers). */
  readonly ctx: BuildingContext;
  readonly profile: CaptureProfile;
  readonly tiles: TileEvidence | null;
  readonly svFetchers: StreetViewFetchers;
  readonly satFetcher: SatelliteFetcher;
  readonly onProgress?: CaptureProgressFn;
  readonly consensus?: {
    readonly models: ModelFetchers;
    readonly renderRound: RenderRoundFn;
    readonly references: readonly Uint8Array[];
    readonly maxRounds?: number;
  };
}

export interface BrowserPipelineResult {
  readonly artifacts: {
    readonly printGlbBytes: ArrayBuffer;
    readonly sceneGlbBytes: ArrayBuffer;
    readonly voxelGrid: Awaited<ReturnType<typeof exportVoxel>>['grid'];
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
  };
  readonly report: FullVerificationReport;
}

/**
 * Run the browser-side pipeline from Stage 4 onward — assumes Stage 3 tile
 * capture was performed by the caller (using its own TilesRenderer setup).
 */
export async function runBrowserPipelineFromTiles(
  input: BrowserPipelineInput,
): Promise<BrowserPipelineResult> {
  const progress = input.onProgress ?? (() => { /* noop */ });

  // Post-3 refinement
  const refined: RefinedBuildingContext = input.tiles && input.tiles.heightmapWidth > 0
    ? refineContextWithTiles(input.ctx, {
        heightmap: input.tiles.heightmap,
        heightmapWidth: input.tiles.heightmapWidth,
        heightmapLength: input.tiles.heightmapLength,
      })
    : ({ ...input.ctx, __refined: true } as unknown as RefinedBuildingContext);

  // Stage 4: SV
  progress({ stage: 'sv', message: 'capturing street view…', ratio: 0 });
  const sv: SvEvidence = await captureStreetView({
    ctx: refined,
    profile: input.profile,
    fetchers: input.svFetchers,
    onProgress: progress,
  });

  // Stage 5: satellite
  progress({ stage: 'satellite', message: 'capturing satellite…', ratio: 0 });
  let sat: SatEvidence | null = null;
  try {
    sat = await captureSatellite({
      lat: refined.center.lat,
      lng: refined.center.lng,
      widthM: refined.mbr.widthM,
      depthM: refined.mbr.depthM,
      tiles: input.tiles,
      profile: input.profile,
      fetcher: input.satFetcher,
      onProgress: progress,
    });
  } catch {
    // Non-fatal — fusion falls back to OSM roof hint + archType default
  }

  // Stage 6: fusion
  const evidence = fuseEvidence({ ctx: refined, tiles: input.tiles, sv, sat });

  // Stage 7: synthesis
  const { brep, path } = synthesize(refined, evidence, input.tiles);

  // Stage 8: exports
  const printResult = await exportPrintGlb(brep);
  const sceneResult = await exportSceneGlb(brep, evidence);
  const voxelResult = await exportVoxel(brep);

  // Stage 9a: objective gates
  const objective = runObjectiveGates({
    positions: printResult.structuralPositions,
    indices: printResult.structuralIndices,
    targetPolygon: evidence.footprint.value,
    meshOrigin: refined.center,
    meshRotationDeg: refined.mbr.rotationDeg,
    expectedHeightM: evidence.heightM.value,
    grid: voxelResult.grid,
  });

  // Stage 9b: optional consensus
  let consensus = undefined;
  if (objective.pass && input.consensus) {
    consensus = await scoreConsensus({
      renderRound: input.consensus.renderRound,
      references: input.consensus.references,
      fetchers: input.consensus.models,
      maxRounds: input.consensus.maxRounds,
    });
  }

  const report = composeReport({ objective, consensus });

  return {
    artifacts: {
      printGlbBytes: printResult.glbBytes,
      sceneGlbBytes: sceneResult.glbBytes,
      voxelGrid: voxelResult.grid,
      voxelBlockCount: voxelResult.blockCount,
      brep,
      synthesisPath: path,
      context: refined,
      evidence,
      captures: { tiles: input.tiles, sv, satellite: sat },
    },
    report,
  };
}
