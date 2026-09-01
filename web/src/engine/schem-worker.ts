/**
 * Web Worker for Minecraft export of a loaded LDraw model.
 *
 * Runs the whole heavy tail of the LEGO tab's .schem/.litematic/build-guide
 * export off the main thread:
 *   voxelizeLDrawGeometry (with a bbox fallback) → fillSingleVoxelGaps →
 *   NBT encode → gzip
 * and streams `{phase, pct}` progress back for the export banner (ui/export-progress).
 *
 * WHY (S3, 2026-09-01): measured on 21063 at the export's chosen cellLDU 4,
 * voxelization alone blocked the main thread for 85 s (now ~6 s after the
 * broad-phase fix, still far past a frame budget) and the encode chain peaked
 * at 1.33 GB RSS for a 0.12 MB file. Both now happen here.
 *
 * Geometry: the worker re-resolves .dat text through the SAME `fetchDatText`
 * path as the main thread (`fetch` is available in module workers, and
 * /ldraw-parts is same-origin), so the output is bit-for-bit what the inline
 * path produced. `.io` CustomParts are not in the library and fall back to the
 * AABB dims fill here exactly as they did inline — no behaviour change.
 */

import type { ParsedBrick } from './ldraw-parser.js';
import { voxelizeLDrawGeometry, setLDrawBase } from './ldraw-geometry.js';
import { voxelizeLDraw, fillSingleVoxelGaps, type VoxelizeOptions } from './ldraw-voxelizer.js';
import { studioColorToBlock } from './studio-colors.js';
import { encodeSchemBytes, encodeLitematicBytes } from '@viewer/exporter.js';
import type { BlockGrid } from '@craft/schem/types.js';

export type SchemWorkerFormat = 'schem' | 'litematic' | 'guide';

export interface SchemWorkerInput {
  bricks: ParsedBrick[];
  /** Which colour table to resolve brick colour ids through (see CLAUDE.md "Color systems"). */
  colorSpace: 'ldraw' | 'bl';
  options: VoxelizeOptions;
  format: SchemWorkerFormat;
  /** Absolute origin for /ldraw-parts fetches inside the worker. */
  ldrawBase: string;
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
    }
  | { type: 'error'; message: string };

/** Extract the transferable buffers from a result message. */
function transfersOf(msg: SchemWorkerOutput): Transferable[] {
  if (msg.type !== 'result') return [];
  const out: Transferable[] = [];
  if (msg.bytes) out.push(msg.bytes.buffer as ArrayBuffer);
  if (msg.grid) out.push(msg.grid.data.buffer as ArrayBuffer);
  return out;
}

self.onmessage = async (event: MessageEvent<SchemWorkerInput>) => {
  const input = event.data;
  const post = (msg: SchemWorkerOutput) =>
    (self as unknown as Worker).postMessage(msg, transfersOf(msg));

  try {
    setLDrawBase(input.ldrawBase);
    const colorFn = input.colorSpace === 'bl' ? studioColorToBlock : undefined;

    // Throttle progress posts — voxelizing fires per brick.
    let lastPost = 0;
    const onProgress = (phase: string, pct?: number) => {
      const now = Date.now();
      if (now - lastPost < 80) return;
      lastPost = now;
      post({ type: 'progress', phase, pct });
    };

    let grid: BlockGrid;
    try {
      const r = await voxelizeLDrawGeometry(input.bricks, colorFn, input.options, onProgress);
      // Near-empty result = part geometry unavailable → bbox fallback.
      grid = r.grid.countNonAir() >= input.bricks.length
        ? r.grid
        : voxelizeLDraw(input.bricks, colorFn, input.options).grid;
    } catch {
      grid = voxelizeLDraw(input.bricks, colorFn, input.options).grid;
    }

    post({ type: 'progress', phase: 'closing surface holes' });
    fillSingleVoxelGaps(grid);
    const nonAir = grid.countNonAir();

    if (input.format === 'guide') {
      post({
        type: 'result',
        grid: {
          width: grid.width, height: grid.height, length: grid.length,
          data: grid.rawData, palette: grid.reversePalette(),
        },
        width: grid.width, height: grid.height, length: grid.length, nonAir,
      });
      return;
    }

    post({ type: 'progress', phase: input.format === 'schem' ? 'writing NBT' : 'writing Litematica NBT' });
    const bytes = input.format === 'schem' ? encodeSchemBytes(grid) : encodeLitematicBytes(grid);
    post({ type: 'result', bytes, width: grid.width, height: grid.height, length: grid.length, nonAir });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
