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
 * Geometry: the main thread seeds `input.datTexts` with every `.dat` text the
 * viewer already resolved (`viewer/ldraw/parts.ts` → `collectDatTexts()`), so
 * exporting the model on screen fetches NOTHING. Names outside the seed still
 * resolve through the same `fetchDatText` path as before (`fetch` works in
 * module workers and /ldraw-parts is same-origin), now with real per-part
 * progress. The seed also carries `.io` CustomParts, which exist only in the
 * archive and previously fell back to an AABB box fill in the export.
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

    // Throttle progress posts — voxelizing and part-loading both fire per item.
    // A phase CHANGE is always posted, never throttled: dropping it would leave
    // the banner showing the previous phase's name and percentage while a
    // different (often indeterminate) stage runs — a stale bar that lies.
    let lastPost = 0;
    let lastPhase: string | null = null;
    const onProgress = (phase: string, pct?: number) => {
      const now = Date.now();
      if (phase === lastPhase && now - lastPost < 80) return;
      lastPost = now;
      lastPhase = phase;
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
