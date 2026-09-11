import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSchemExportWorker } from '../web/src/ui/schem-export.js';
import type { SchemWorkerInput, SchemWorkerOutput } from '../web/src/engine/schem-pipeline.js';

const runSchemPipeline = vi.hoisted(() => vi.fn());
vi.mock('@engine/schem-pipeline.js', () => ({ runSchemPipeline }));
vi.mock('@viewer/exporter.js', () => ({ exportLayerGuide: vi.fn() }));
vi.mock('@viewer/ldraw/parts.js', () => ({ collectDatTexts: vi.fn(() => new Map()) }));
vi.mock('@ui/export-progress.js', () => ({ beginExportProgress: vi.fn() }));

const input: SchemWorkerInput = {
  source: { kind: 'grid', width: 1, height: 1, length: 1, data: new Uint16Array(1), palette: ['minecraft:air'] },
  format: 'guide', profile: 'default', lightFill: false, shapes: false,
};

class PipelineErrorWorker {
  onmessage: ((event: MessageEvent<SchemWorkerOutput>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminate = vi.fn();
  postMessage(): void {
    queueMicrotask(() => this.onmessage?.({ data: { type: 'error', message: 'geometry budget exceeded' } } as MessageEvent<SchemWorkerOutput>));
  }
}

describe('runSchemExportWorker error handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    runSchemPipeline.mockReset();
  });

  it('propagates a worker pipeline error without retrying stale inline code', async () => {
    vi.stubGlobal('Worker', PipelineErrorWorker);
    await expect(runSchemExportWorker(input, vi.fn())).rejects.toThrow('geometry budget exceeded');
    expect(runSchemPipeline).not.toHaveBeenCalled();
  });

  it('falls back inline once when worker construction fails', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('worker unavailable'); } });
    runSchemPipeline.mockResolvedValue({
      grid: { width: 1, height: 1, length: 1 }, nonAir: 0, lights: 0,
    });
    const result = await runSchemExportWorker(input, vi.fn());
    expect(runSchemPipeline).toHaveBeenCalledOnce();
    expect(result.inline).toBe(true);
  });
});
