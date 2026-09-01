/**
 * The one Minecraft-export entry point for the whole app (S4).
 *
 * Both export surfaces call `runMinecraftExport`:
 *   • LEGO tab (`ui/lego.ts`)      — source = parsed LDraw bricks.
 *   • Upload tab / inline viewers  — source = the BlockGrid already loaded
 *     (`main.ts` download menu; the tab imports a .schem/.litematic/mesh, so
 *     "export" is encode-only — no re-voxelization).
 *
 * It owns: resolution planning, the export Web Worker (+ the identical inline
 * fallback), the fixed progress banner, the build-guide hand-off and the
 * download. Nothing else in the app may encode a .schem/.litematic for a user
 * download — that duplication is what S4 removed.
 */

import { BlockGrid } from '@craft/schem/types.js';
import type { ParsedBrick } from '@engine/ldraw-parser.js';
import type { VoxelizeOptions } from '@engine/ldraw-voxelizer.js';
import { runSchemPipeline, type SchemWorkerInput, type SchemWorkerOutput, type SchemWorkerFormat } from '@engine/schem-pipeline.js';
import type { BrickColorSpace } from '@engine/block-profiles.js';
import {
  planResolution, spanOfBricks, DEFAULT_SCHEM_SETTINGS,
  type SchemExportSettings,
} from '@engine/schem-settings.js';
import { exportLayerGuide } from '@viewer/exporter.js';
import { beginExportProgress, type ExportProgressHandle } from '@ui/export-progress.js';

export type { SchemWorkerFormat };
/** Re-exported so UI callers have one import for everything export-related. */
export { spanOfBricks };

/** Trigger a browser download of raw bytes. */
export function downloadBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

export interface SchemExportJob {
  bytes?: Uint8Array;
  grid?: BlockGrid;
  width: number; height: number; length: number; nonAir: number; lights: number;
  /** True when the work ran inline because a Worker could not be created. */
  inline: boolean;
}

/**
 * Run the pipeline in the export Web Worker, streaming `{phase, pct}` to the
 * caller. Falls back to running the SAME code inline on the main thread when
 * the Worker can't be constructed (old browser, blocked module worker) — the
 * inline path calls `runSchemPipeline` directly, so it cannot drift.
 */
export async function runSchemExportWorker(
  input: SchemWorkerInput,
  onProgress: (phase: string, pct?: number) => void,
): Promise<SchemExportJob> {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('@engine/schem-worker.ts', import.meta.url), { type: 'module' });
  } catch (err) {
    console.warn('[schem-export] worker unavailable, running inline:', err);
  }

  if (worker) {
    try {
      return await new Promise<SchemExportJob>((resolve, reject) => {
        const w = worker!;
        w.onmessage = (ev: MessageEvent<SchemWorkerOutput>) => {
          const msg = ev.data;
          if (msg.type === 'progress') { onProgress(msg.phase, msg.pct); return; }
          if (msg.type === 'error') { w.terminate(); reject(new Error(msg.message)); return; }
          w.terminate();
          resolve({
            bytes: msg.bytes,
            grid: msg.grid
              ? BlockGrid.fromRaw(msg.grid.width, msg.grid.height, msg.grid.length, msg.grid.data, msg.grid.palette)
              : undefined,
            width: msg.width, height: msg.height, length: msg.length,
            nonAir: msg.nonAir, lights: msg.lights,
            inline: false,
          });
        };
        w.onerror = (e) => { w.terminate(); reject(new Error(`Export worker error: ${e.message}`)); };
        w.postMessage(input);
      });
    } catch (err) {
      console.warn('[schem-export] worker failed, retrying inline:', err);
    }
  }

  const r = await runSchemPipeline(input, onProgress);
  return {
    bytes: r.bytes,
    grid: input.format === 'guide' ? r.grid : undefined,
    width: r.grid.width, height: r.grid.height, length: r.grid.length,
    nonAir: r.nonAir, lights: r.lights,
    inline: true,
  };
}

export type MinecraftExportSource =
  | { kind: 'bricks'; bricks: ParsedBrick[]; colorSpace: BrickColorSpace }
  | { kind: 'grid'; grid: BlockGrid };

export interface MinecraftExportRequest {
  source: MinecraftExportSource;
  format: SchemWorkerFormat;
  /** Filename stem, e.g. "21063" → 21063.schem. */
  basename: string;
  settings?: SchemExportSettings;
  /** Mirror phase/result text into a tab's own status line (the LEGO tab's log). */
  onStatus?: (message: string, kind: 'info' | 'success' | 'error') => void;
}

export interface MinecraftExportResult {
  ok: boolean;
  message: string;
  width?: number; height?: number; length?: number; nonAir?: number; lights?: number;
}

/**
 * Export a loaded model (bricks or grid) as .schem / .litematic / build guide.
 * Shows the progress banner, downloads the file, returns a summary line.
 */
export async function runMinecraftExport(req: MinecraftExportRequest): Promise<MinecraftExportResult> {
  const settings = req.settings ?? DEFAULT_SCHEM_SETTINGS;
  const base = req.basename || 'model';
  const { format } = req;
  const status = req.onStatus ?? (() => {});
  let progress: ExportProgressHandle | null = null;

  try {
    let input: SchemWorkerInput;
    let resNote = '';

    if (req.source.kind === 'bricks') {
      // The build guide is meant to be humanly followable — it stays at one
      // block per stud regardless of the resolution setting.
      const plan = format === 'guide'
        ? planResolution(spanOfBricks(req.source.bricks), '20')
        : planResolution(spanOfBricks(req.source.bricks), settings.resolution);
      const opts: VoxelizeOptions = { cellLDU: plan.cellLDU, maxDim: 700 };
      resNote = ` at ${plan.cellsPerStud}× stud resolution (proportion-exact)`;
      status(`Voxelizing for Minecraft at ${plan.cellsPerStud}× stud resolution (${plan.cellLDU} LDU cells)…`, 'info');
      if (!plan.requestedHonored) {
        status(`Requested ${20 / (plan.requestedCellLDU ?? 20)}× stud resolution exceeds Minecraft-sane bounds — using ${plan.cellsPerStud}×.`, 'info');
      }
      input = {
        source: { kind: 'bricks', bricks: req.source.bricks, colorSpace: req.source.colorSpace, options: opts },
        format, profile: settings.profile, lightFill: settings.lightFill,
        ldrawBase: new URL('/ldraw-parts', location.origin).toString(),
      };
    } else {
      const g = req.source.grid;
      status(`Encoding ${g.width}×${g.height}×${g.length} blocks…`, 'info');
      input = {
        // The grid is the model — copy the raw buffer so the worker's transfer
        // can't detach the array the tab's 3D viewer is still using.
        source: {
          kind: 'grid', width: g.width, height: g.height, length: g.length,
          data: new Uint16Array(g.rawData), palette: g.reversePalette(),
        },
        format, profile: settings.profile, lightFill: settings.lightFill,
      };
    }

    const bannerTitle = format === 'guide' ? `${base} build guide` : `${base}.${format}`;
    progress = beginExportProgress(bannerTitle);
    progress.update(req.source.kind === 'bricks' ? 'voxelizing' : 'encoding');
    // Yield a frame so the banner paints before the heavy work starts.
    await new Promise(r => setTimeout(r, 0));

    const job = await runSchemExportWorker(input, (phase, pct) => progress?.update(phase, pct));
    const blocks = job.nonAir;
    const lightNote = job.lights > 0 ? `, ${job.lights.toLocaleString()} interior lights` : '';

    if (format === 'guide') {
      progress.update('writing build guide');
      exportLayerGuide(job.grid!, base, `${base}-build-guide.html`);
      const msg = `Exported ${base}-build-guide.html (${job.height} layers, ${blocks.toLocaleString()} blocks)`;
      status(msg, 'success');
      progress.done(msg);
      return { ok: true, message: msg, width: job.width, height: job.height, length: job.length, nonAir: blocks, lights: job.lights };
    }

    progress.update('downloading');
    downloadBytes(job.bytes!, `${base}.${format}`);
    const msg = `Exported ${base}.${format} — ${blocks.toLocaleString()} blocks${resNote}, ${job.width}×${job.height}×${job.length}${lightNote}`;
    status(msg, 'success');
    progress.done(`${blocks.toLocaleString()} blocks · ${job.width}×${job.height}×${job.length}`);
    return { ok: true, message: msg, width: job.width, height: job.height, length: job.length, nonAir: blocks, lights: job.lights };
  } catch (err) {
    const message = `Export failed: ${err instanceof Error ? err.message : String(err)}`;
    status(message, 'error');
    progress?.fail(message);
    return { ok: false, message };
  }
}
