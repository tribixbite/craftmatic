/**
 * THE shared Minecraft-export pipeline — one implementation for every tab.
 *
 * Two sources feed it:
 *   • `bricks` — a parsed LDraw model (LEGO tab): voxelize → close 1-cell gaps
 *     → [optional light fill] → NBT → gzip.
 *   • `grid`   — a BlockGrid that already exists (Upload tab, generator, tiles):
 *     [optional light fill] → NBT → gzip. No voxelization, no gap fill; the
 *     grid IS the model and re-voxelizing it would be lossy.
 *
 * It runs in `schem-worker.ts` (off the main thread — see S3: 85 s of blocked
 * main thread and a 1.33 GB allocation peak) and, unchanged, inline when a
 * Worker can't be constructed. Both callers go through `ui/schem-export.ts`;
 * nothing else may re-implement voxelize/encode.
 *
 * BYTE-IDENTITY: with the shipped defaults (auto resolution, default profile,
 * light fill OFF) the bricks path is exactly the pre-S4 sequence — same
 * functions, same order, same `undefined` colorFn for LDraw-space models. The
 * 21063 reference sha256 gate depends on it.
 */

import type { ParsedBrick } from './ldraw-parser.js';
import { voxelizeLDrawGeometry, seedDatTexts } from './ldraw-geometry.js';
import { voxelizeLDraw, fillSingleVoxelGaps, type VoxelizeOptions } from './ldraw-voxelizer.js';
import { encodeSchemBytes, encodeLitematicBytes } from './schem-encode.js';
import { addInteriorLights, type LightFillResult } from './light-fill.js';
import { getBlockProfile, type BrickColorSpace } from './block-profiles.js';
import { BlockGrid } from '@craft/schem/types.js';

export type SchemWorkerFormat = 'schem' | 'litematic' | 'guide';

/** A parsed LDraw model that still needs voxelizing. */
export interface BrickSource {
  kind: 'bricks';
  bricks: ParsedBrick[];
  /** Which colour table to resolve brick colour ids through (CLAUDE.md "Color systems"). */
  colorSpace: BrickColorSpace;
  options: VoxelizeOptions;
}

/** An already-voxelized grid, transferred as raw parts (see BlockGrid.fromRaw). */
export interface GridSource {
  kind: 'grid';
  width: number;
  height: number;
  length: number;
  data: Uint16Array;
  palette: string[];
}

export type SchemSource = BrickSource | GridSource;

export interface SchemWorkerInput {
  source: SchemSource;
  format: SchemWorkerFormat;
  /** Block-mapping profile id (block-profiles.ts). */
  profile: string;
  /** Light up enclosed interiors after voxelization. */
  lightFill: boolean;
  /** Absolute origin for /ldraw-parts fetches inside the worker (bricks only). */
  ldrawBase?: string;
  /**
   * Part name → `.dat` text already resolved on the main thread (`null` = a
   * known-definitive miss). Seeds the geometry resolver so exporting a model
   * that is already loaded and rendered fetches NOTHING. Bricks only; anything
   * absent from the map is fetched as before (with progress).
   */
  datTexts?: ReadonlyMap<string, string | null>;
}

export type SchemWorkerOutput =
  | { type: 'progress'; phase: string; pct?: number }
  | {
      type: 'result';
      /** schem/litematic: the finished gzipped file bytes. */
      bytes?: Uint8Array;
      /** guide: raw grid so the main thread can render the HTML. */
      grid?: { width: number; height: number; length: number; data: Uint16Array; palette: string[] };
      width: number;
      height: number;
      length: number;
      nonAir: number;
      /** Non-zero only when the light-fill option was on. */
      lights: number;
    }
  | { type: 'error'; message: string };

export type ProgressFn = (phase: string, pct?: number) => void;

export interface SchemPipelineResult {
  grid: BlockGrid;
  bytes?: Uint8Array;
  nonAir: number;
  lights: number;
  lightFill?: LightFillResult;
}

/**
 * Build the grid and (unless `format === 'guide'`) encode it.
 * Pure with respect to the DOM — safe in a Worker and in Node tests.
 */
export async function runSchemPipeline(
  input: SchemWorkerInput,
  onProgress: ProgressFn = () => {},
): Promise<SchemPipelineResult> {
  const profile = getBlockProfile(input.profile);
  let grid: BlockGrid;

  if (input.source.kind === 'grid') {
    const s = input.source;
    grid = BlockGrid.fromRaw(s.width, s.height, s.length, s.data, s.palette);
  } else {
    const s = input.source;
    const colorFn = profile.colorFn(s.colorSpace);
    // Reuse the .dat texts the viewer already downloaded (see seedDatTexts):
    // the model on screen costs zero further network, and `.io` CustomParts —
    // which exist ONLY in the archive and used to hit the AABB box fallback
    // here — now voxelize from their real geometry.
    if (input.datTexts && input.datTexts.size > 0) {
      onProgress('reusing loaded part geometry');
      seedDatTexts(input.datTexts);
    }
    try {
      const r = await voxelizeLDrawGeometry(s.bricks, colorFn, s.options, onProgress);
      // Near-empty result = part geometry unavailable → bbox fallback.
      grid = r.grid.countNonAir() >= s.bricks.length
        ? r.grid
        : voxelizeLDraw(s.bricks, colorFn, s.options).grid;
    } catch {
      grid = voxelizeLDraw(s.bricks, colorFn, s.options).grid;
    }
    onProgress('closing surface holes');
    fillSingleVoxelGaps(grid);
  }

  let lightFill: LightFillResult | undefined;
  if (input.lightFill) {
    onProgress('lighting enclosed interiors');
    lightFill = addInteriorLights(grid, { lightBlock: profile.lightBlock });
  }

  const nonAir = grid.countNonAir();
  const lights = lightFill?.lights ?? 0;
  if (input.format === 'guide') return { grid, nonAir, lights, lightFill };

  onProgress(input.format === 'schem' ? 'writing NBT' : 'writing Litematica NBT');
  const bytes = input.format === 'schem' ? encodeSchemBytes(grid) : encodeLitematicBytes(grid);
  return { grid, bytes, nonAir, lights, lightFill };
}
