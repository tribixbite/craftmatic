/**
 * Build a `TileEvidence` from a locally cached GLB file.
 *
 * Used as a network-free alternative to `captureTiles()` when:
 *   • Google 3D Tiles API is rate-limiting / returning ECONNRESET
 *   • Iterating offline against a known-good cached photogrammetry capture
 *   • Reproducing a specific run (deterministic input)
 *
 * Heightmap rasterization mirrors the live-capture path so downstream
 * code (refineContextWithTiles, slice synthesizer, voxel export) sees an
 * identical-shape `TileEvidence`.
 */

import { readFileSync } from 'node:fs';
import { parseGlbMeshes } from '../export/glb-writer.js';
import {
  BboxAccumulator,
  addPositionsToHeightmap,
  createHeightmapState,
  isHeightTruncated,
  normaliseHeightmap,
} from './heightmap.js';
import type { TileEvidence } from './types.js';

export interface TilesFromGlbOptions {
  readonly path: string;
  readonly expectedHeightM: number;
}

export function buildTileEvidenceFromGlbFile(
  opts: TilesFromGlbOptions,
): TileEvidence {
  const fileBytes = readFileSync(opts.path);
  const ab = fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength);
  const meshes = parseGlbMeshes(ab);

  // Combined bbox across all primitives
  const bbox = new BboxAccumulator();
  for (const m of meshes) bbox.addPositions(m.positions);
  const measured = bbox.get() ?? { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

  // Heightmap rasterization at 1 sample/m
  const hmState = createHeightmapState(measured, 1);
  if (hmState) {
    for (const m of meshes) addPositionsToHeightmap(hmState, m.positions);
    normaliseHeightmap(hmState);
  }

  const truncated = isHeightTruncated(measured, opts.expectedHeightM);

  return {
    glbPath: opts.path,
    glbBytes: ab,
    heightmap: hmState?.heights ?? new Float32Array(0),
    heightmapWidth: hmState?.width ?? 0,
    heightmapLength: hmState?.length ?? 0,
    measuredBbox: {
      min: { x: measured.minX, y: measured.minY, z: measured.minZ },
      max: { x: measured.maxX, y: measured.maxY, z: measured.maxZ },
    },
    truncated,
    meshCount: meshes.length,
    noCoverage: meshes.length < 3,
    meshes,
  };
}
