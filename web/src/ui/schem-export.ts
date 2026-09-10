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
import {
  runSchemPipeline,
  type SchemWorkerInput, type SchemWorkerOutput, type SchemWorkerFormat, type McpackSummary,
} from '@engine/schem-pipeline.js';
import type { BrickColorSpace } from '@engine/block-profiles.js';
import {
  planResolution, spanOfBricks, DEFAULT_SCHEM_SETTINGS,
  type SchemExportSettings,
} from '@engine/schem-settings.js';
import { safeFilenameStem } from '@engine/export-name.js';
import { exportLayerGuide } from '@viewer/exporter.js';
import { collectDatTexts } from '@viewer/ldraw/parts.js';
import { beginExportProgress, type ExportProgressHandle } from '@ui/export-progress.js';
import {
  createLiveSession, LiveDelivery,
  type LiveDeliveryProgress, type LiveDeliveryResult,
} from '@engine/live-delivery.js';
import { checksum } from '@engine/hotschem/live-import.js';

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

const LIVE_ADDON_URL = '/downloads/HotSchem-Live-0.6.0.mcaddon';

/** Copy text even on local HTTP, where the async Clipboard API may be absent. */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

function liveProgressText(p: LiveDeliveryProgress): string {
  if (p.message) return p.message;
  switch (p.phase) {
    case 'connecting': return 'Connecting securely to the Craftmatic relay…';
    case 'pairing': return 'Waiting for the Minecraft world host to run the pairing command…';
    case 'probing': return 'Minecraft connected. Checking the HotSchem add-on…';
    case 'transferring': return p.total > 0
      ? `Sending build to Minecraft… ${p.acknowledged.toLocaleString()} / ${p.total.toLocaleString()}`
      : 'Sending build to Minecraft…';
    case 'committing': return 'Transfer complete. Waiting for Minecraft to commit the build…';
    case 'complete': return 'Minecraft committed the build.';
  }
}

/**
 * Pair the browser with a Bedrock world and deliver one already-encoded HS1
 * model. The promise resolves only after the add-on acknowledges its commit.
 */
async function deliverLiveModel(
  encoded: string,
  onProgress: (phase: string, pct?: number) => void,
  warnings: readonly string[] = [],
): Promise<LiveDeliveryResult> {
  document.getElementById('live-delivery-dialog')?.remove();

  const dialog = document.createElement('div');
  dialog.id = 'live-delivery-dialog';
  dialog.className = 'live-delivery-backdrop';
  dialog.innerHTML = `
    <section class="live-delivery-card" role="dialog" aria-modal="true" aria-labelledby="live-delivery-title">
      <h2 id="live-delivery-title">Send to Minecraft Planner <small>(experimental)</small></h2>
      <p>This saves the build in the HotSchem Planner library. Choose its position and place it from the Planner in Minecraft; delivery does not place blocks immediately.</p>
      <p>Experimental: the hosted connection is not yet working on our Android test device. Use a Bedrock download if pairing fails.</p>
      <ol class="live-delivery-steps">
        <li><a class="btn btn-secondary btn-sm" href="${LIVE_ADDON_URL}" download>Download HotSchem Live add-on</a> <span>Install it once, then activate it on the world.</span></li>
        <li>Enable WebSockets in Minecraft’s General settings and keep Require Encrypted WebSockets enabled. Open a single-player world with cheats enabled as its host.</li>
        <li><span>Run in Minecraft chat:</span><div class="live-delivery-command"><code>Creating pairing command…</code><button type="button" class="btn btn-secondary btn-sm" data-action="copy" disabled>Copy</button></div></li>
      </ol>
      <div class="live-delivery-warnings" hidden><strong>Before sending:</strong><ul></ul></div>
      <div class="live-delivery-meter" role="progressbar" aria-label="Live delivery progress"><span></span></div>
      <p class="live-delivery-status" aria-live="polite">Creating a secure delivery session…</p>
      <div class="live-delivery-actions">
        <button type="button" class="btn btn-primary btn-sm" data-action="retry" hidden>Retry</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="cancel">Cancel</button>
      </div>
    </section>`;
  document.body.appendChild(dialog);

  const command = dialog.querySelector<HTMLElement>('.live-delivery-command code')!;
  const copy = dialog.querySelector<HTMLButtonElement>('[data-action="copy"]')!;
  const retry = dialog.querySelector<HTMLButtonElement>('[data-action="retry"]')!;
  const cancel = dialog.querySelector<HTMLButtonElement>('[data-action="cancel"]')!;
  const status = dialog.querySelector<HTMLElement>('.live-delivery-status')!;
  const warningBox = dialog.querySelector<HTMLElement>('.live-delivery-warnings')!;
  const warningList = warningBox.querySelector<HTMLUListElement>('ul')!;
  const meter = dialog.querySelector<HTMLElement>('.live-delivery-meter')!;
  const bar = meter.querySelector<HTMLElement>('span')!;

  for (const warning of warnings) {
    const item = document.createElement('li');
    item.textContent = warning;
    warningList.appendChild(item);
  }
  warningBox.hidden = warnings.length === 0;

  let controller: AbortController | null = null;
  let delivery: LiveDelivery | null = null;
  let pairingCommand = '';
  let settled = false;

  copy.addEventListener('click', async () => {
    if (!pairingCommand) return;
    try {
      await copyText(pairingCommand);
      copy.textContent = 'Copied';
      setTimeout(() => { if (copy.isConnected) copy.textContent = 'Copy'; }, 1400);
    } catch {
      status.textContent = 'Copy was blocked. Select the command and copy it manually.';
    }
  });

  return await new Promise<LiveDeliveryResult>((resolve, reject) => {
    const finishCancel = (): void => {
      controller?.abort();
      delivery?.close();
      dialog.remove();
      if (!settled) {
        settled = true;
        reject(new DOMException('Live delivery canceled.', 'AbortError'));
      }
    };

    cancel.addEventListener('click', finishCancel);
    dialog.addEventListener('click', e => { if (e.target === dialog) finishCancel(); });

    const attempt = async (): Promise<void> => {
      controller?.abort();
      delivery?.close();
      controller = new AbortController();
      const { signal } = controller;
      retry.hidden = true;
      cancel.textContent = 'Cancel';
      copy.disabled = true;
      pairingCommand = '';
      command.textContent = 'Creating pairing command…';
      status.textContent = 'Creating a secure delivery session…';
      meter.removeAttribute('aria-valuenow');
      bar.style.width = '0%';

      try {
        const info = await createLiveSession(location.origin, signal);
        pairingCommand = info.pairingCommand;
        command.textContent = pairingCommand;
        copy.disabled = false;
        delivery = new LiveDelivery(info);
        await delivery.connect(signal);
        const result = await delivery.deliver(encoded, checksum(encoded), {
          signal,
          onProgress: p => {
            const text = liveProgressText(p);
            status.textContent = text;
            const pct = p.total > 0 ? Math.round(p.acknowledged / p.total * 100) : undefined;
            if (pct != null) {
              bar.style.width = `${pct}%`;
              meter.setAttribute('aria-valuenow', String(pct));
            }
            onProgress(text, pct);
          },
        });
        if (signal.aborted || settled) return;
        settled = true;
        status.textContent = `Minecraft committed the build for ${result.player}. You can close this window.`;
        status.classList.add('success');
        bar.style.width = '100%';
        meter.setAttribute('aria-valuenow', '100');
        cancel.textContent = 'Done';
        delivery.close();
        resolve(result);
      } catch (err) {
        if (signal.aborted || settled) return;
        delivery?.close();
        status.textContent = `Delivery stopped: ${err instanceof Error ? err.message : String(err)}`;
        status.classList.add('error');
        retry.hidden = false;
      }
    };

    retry.addEventListener('click', () => { status.classList.remove('error'); void attempt(); });
    void attempt();
  });
}

export interface SchemExportJob {
  bytes?: Uint8Array;
  grid?: BlockGrid;
  width: number; height: number; length: number; nonAir: number; lights: number;
  /** True when the work ran inline because a Worker could not be created. */
  inline: boolean;
  /** Present only for the Bedrock `.mcpack` format. */
  mcpack?: McpackSummary;
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
            ...(msg.mcpack ? { mcpack: msg.mcpack } : {}),
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
    ...(r.mcpack ? { mcpack: r.mcpack } : {}),
  };
}

export type MinecraftExportSource =
  | { kind: 'bricks'; bricks: ParsedBrick[]; colorSpace: BrickColorSpace }
  | { kind: 'grid'; grid: BlockGrid };

export interface MinecraftExportRequest {
  source: MinecraftExportSource;
  format: SchemWorkerFormat;
  /**
   * Filename stem, e.g. "Colosseum-10276" → Colosseum-10276.schem. Build it with
   * `engine/export-name.ts` `modelExportStem()` — name first, then set number,
   * and never the internal source suffix. Sanitized again here so no caller can
   * put a path separator in a download name.
   */
  basename: string;
  /**
   * Human-readable model name for surfaces that show one to the user — the
   * Bedrock pack's display name in Minecraft's pack list, for instance, where
   * `Colosseum (10276)` reads better than the filename stem. Defaults to
   * `basename`.
   */
  label?: string;
  settings?: SchemExportSettings;
  /** Override the interactive Bedrock add-on's automatic vehicle classifier. */
  vehicleMode?: 'auto' | 'car' | 'plane' | 'static';
  /** Mirror phase/result text into a tab's own status line (the LEGO tab's log). */
  onStatus?: (message: string, kind: 'info' | 'success' | 'error') => void;
}

export interface MinecraftExportResult {
  ok: boolean;
  message: string;
  width?: number; height?: number; length?: number; nonAir?: number; lights?: number;
  /** Present only for the Bedrock `.mcpack` format. */
  mcpack?: McpackSummary;
}

/**
 * Export a loaded model (bricks or grid) as .schem / .litematic / .mcpack /
 * build guide. Shows the progress banner, downloads the file, returns a summary.
 */
export async function runMinecraftExport(req: MinecraftExportRequest): Promise<MinecraftExportResult> {
  const settings = req.settings ?? DEFAULT_SCHEM_SETTINGS;
  const base = safeFilenameStem(req.basename ?? '') || 'model';
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
      // Hand the export every .dat text the viewer already downloaded. The
      // export resolver (engine/ldraw-geometry.ts) has its OWN cache — a
      // different module, and in the worker a different thread — so without
      // this an export of the model on screen re-downloaded the whole part
      // library. Seeded names are never fetched; anything missing still is.
      const datTexts = collectDatTexts();
      input = {
        source: { kind: 'bricks', bricks: req.source.bricks, colorSpace: req.source.colorSpace, options: opts },
        format, profile: settings.profile, lightFill: settings.lightFill,
        shapes: settings.shapes,
        ldrawBase: new URL('/ldraw-parts', location.origin).toString(),
        datTexts,
        packStem: base,
        packLabel: req.label ?? base,
        vehicleMode: req.vehicleMode ?? 'auto',
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
          blockEntities: structuredClone(g.blockEntities),
        },
        // An uploaded grid is already blocks — there is no sub-cell occupancy
        // left to refine from, so the shape pass has nothing to work with.
        format, profile: settings.profile, lightFill: settings.lightFill, shapes: false,
        packStem: base,
        packLabel: req.label ?? base,
        vehicleMode: req.vehicleMode ?? 'auto',
      };
    }

    const bannerTitle = format === 'guide' ? `${base} build guide` : `${base}.${format}`;
    progress = beginExportProgress(bannerTitle);
    // Indeterminate until the pipeline reports its first real phase — claiming
    // "voxelizing" here was a lie (part geometry is resolved first).
    progress.update(req.source.kind === 'bricks' ? 'preparing part geometry' : 'encoding');
    // Yield a frame so the banner paints before the heavy work starts.
    await new Promise(r => setTimeout(r, 0));

    const job = await runSchemExportWorker(input, (phase, pct) => progress?.update(phase, pct));
    const blocks = job.nonAir;
    const lightNote = job.lights > 0 ? `, ${job.lights.toLocaleString()} interior lights` : '';

    if (format === 'live') {
      const encoded = new TextDecoder().decode(job.bytes!);
      const liveWarnings = job.mcpack?.warnings ?? [];
      for (const warning of liveWarnings) status(`Live-delivery warning: ${warning}`, 'info');
      const delivered = await deliverLiveModel(encoded, (phase, pct) => progress?.update(phase, pct), liveWarnings);
      const msg = `Minecraft committed ${base} for ${delivered.player} — ${blocks.toLocaleString()} blocks, ${delivered.bytes.toLocaleString()} bytes`;
      status(msg, 'success');
      progress.done(msg);
      return { ok: true, message: msg, width: job.width, height: job.height, length: job.length, nonAir: blocks, lights: job.lights };
    }

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

    // Bedrock: the file alone is not actionable — the user needs the command
    // that places it and a warning about the blocks that had no equivalent.
    if ((format === 'mcpack' || format === 'mcaddon') && job.mcpack) {
      const { functionCommand, tileCount, unmapped, warnings = [], components = [] } = job.mcpack;
      const tileNote = tileCount > 1
        ? `, split into ${tileCount} structures (Bedrock caps one at 64×384×64)`
        : '';
      const componentNote = format === 'mcaddon'
        ? (components.length > 0 ? ` Interactive components: ${components.join(', ')}.` : ' No interactive component was identified; the structure remains static.')
        : '';
      const activation = format === 'mcaddon'
        ? `Open it with Minecraft, activate both the behavior and resource packs, rejoin the world, then run ${functionCommand} where the model should go.`
        : `Open it with Minecraft, activate the behavior pack, then run ${functionCommand} where the model should go.`;
      const msg = `Exported ${base}.${format} — ${blocks.toLocaleString()} blocks${resNote}, `
        + `${job.width}×${job.height}×${job.length}${lightNote}${tileNote}. ${activation}${componentNote}`;
      status(msg, 'success');
      if (unmapped.length > 0) {
        status(`${unmapped.length} block type(s) had no Bedrock equivalent and were left as air: ${unmapped.join(', ')}`, 'info');
      }
      for (const warning of warnings) status(`Add-on warning: ${warning}`, 'info');
      const interactionSummary = format === 'mcaddon'
        ? ` · ${components.length} interactive component${components.length === 1 ? '' : 's'}${warnings.length ? ` · ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}`
        : '';
      progress.done(`${blocks.toLocaleString()} blocks · ${tileCount} structure${tileCount === 1 ? '' : 's'}${interactionSummary} · ${functionCommand}`);
      return {
        ok: true, message: msg,
        width: job.width, height: job.height, length: job.length,
        nonAir: blocks, lights: job.lights, mcpack: job.mcpack,
      };
    }

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
