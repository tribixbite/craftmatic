/**
 * Web Worker shell for the Minecraft export.
 *
 * All of the work lives in `schem-pipeline.ts` (shared with the inline
 * fallback in `ui/schem-export.ts`, so the two paths cannot drift). This file
 * is only the message plumbing: point the part loader at the right origin,
 * throttle progress posts, transfer the result buffers.
 *
 * WHY a worker (S3, 2026-09-01): measured on 21063 at the export's chosen
 * cellLDU 4, voxelization alone blocked the main thread for 85 s (now ~6 s
 * after the broad-phase fix, still far past a frame budget) and the encode
 * chain peaked at 1.33 GB RSS for a 0.12 MB file.
 *
 * Geometry: the worker re-resolves .dat text through the SAME `fetchDatText`
 * path as the main thread (`fetch` is available in module workers, and
 * /ldraw-parts is same-origin), so the output is bit-for-bit what the inline
 * path produced. `.io` CustomParts are not in the library and fall back to the
 * AABB dims fill here exactly as they did inline — no behaviour change.
 */

import { setLDrawBase } from './ldraw-geometry.js';
import { runSchemPipeline, type SchemWorkerInput, type SchemWorkerOutput } from './schem-pipeline.js';

export type { SchemWorkerInput, SchemWorkerOutput, SchemWorkerFormat } from './schem-pipeline.js';

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
    if (input.ldrawBase) setLDrawBase(input.ldrawBase);

    // Throttle progress posts — voxelizing fires per brick.
    let lastPost = 0;
    const onProgress = (phase: string, pct?: number) => {
      const now = Date.now();
      if (now - lastPost < 80) return;
      lastPost = now;
      post({ type: 'progress', phase, pct });
    };

    const { grid, bytes, nonAir, lights } = await runSchemPipeline(input, onProgress);

    post({
      type: 'result',
      bytes,
      grid: input.format === 'guide'
        ? {
            width: grid.width, height: grid.height, length: grid.length,
            data: grid.rawData, palette: grid.reversePalette(),
          }
        : undefined,
      width: grid.width, height: grid.height, length: grid.length, nonAir, lights,
    });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
