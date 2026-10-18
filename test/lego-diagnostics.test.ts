/**
 * Offline tests for the LEGO tab's diagnostic bundle
 * (`web/src/ui/lego-diagnostics.ts`).
 *
 * The bundle's whole value is that it does not overstate what it knows, so the
 * invariants under test are the honesty ones:
 *  - intended vs loaded source are distinct, and `fellBack` is DERIVED
 *  - a never-measured source reports 'unverified', never a clean bill
 *  - absent measurements are null, not 0
 *  - the output is JSON-serializable (it is downloaded verbatim)
 */

import { describe, it, expect } from 'vitest';
import { buildLegoDiagnostics, diagnosticsFilename } from '../web/src/ui/lego-diagnostics.js';
import type { IndexModel, LegoModelsIndex } from '../web/src/engine/lego-sources.js';

const M = (src: string, path: string, extra: Partial<IndexModel> = {}): IndexModel =>
  ({ src, path, tier: 1, steps: 0, n: 100, ...extra });

const IDX: LegoModelsIndex = {
  generated: '2026-09-09', schema: 2,
  geograde: { generated: '2026-09-03 00:43:51', graded: 9609, stale: 2749 },
  sets: {},
};

const MODELS: IndexModel[] = [
  M('mecabricks', 'MecabricksLDR/10316.ldr', {
    n: 6271, asm: 'defective', sev: 12.5, defects: ['overlap 2.1 % of parts'],
    hash: 'aabbccddeeff', lineage: 'mb_align v2 good',
  }),
  M('pdf_recon', 'Reconstructed/10316_reconstructed.ldr', { tier: 2, n: 7784 }),
];

describe('buildLegoDiagnostics', () => {
  it('records the intended and the actually-loaded source separately', () => {
    const d = buildLegoDiagnostics({
      setNum: '10316-1', setName: 'Rivendell', index: IDX, models: MODELS,
      intendedIndex: 0, loadedIndex: 1,
      attempts: [{ src: 'mecabricks', path: 'MecabricksLDR/10316.ldr', error: 'HTTP 404' }],
      sourceUrl: '/lego-models/Reconstructed/10316_reconstructed.ldr',
      now: '2026-09-09T00:00:00.000Z',
    }) as Record<string, Record<string, unknown>>;
    const src = d['source']!;
    expect((src['intended'] as Record<string, unknown>)['src']).toBe('mecabricks');
    expect((src['loaded'] as Record<string, unknown>)['src']).toBe('pdf_recon');
    expect(src['fellBack']).toBe(true);
    expect(src['attempts']).toHaveLength(1);
    expect(src['url']).toBe('/lego-models/Reconstructed/10316_reconstructed.ldr');
  });

  it('does not claim a fallback when the intended source loaded', () => {
    const d = buildLegoDiagnostics({
      models: MODELS, intendedIndex: 0, loadedIndex: 0, now: 'x',
    }) as Record<string, Record<string, unknown>>;
    expect(d['source']!['fellBack']).toBe(false);
    expect(d['source']!['pickReason']).toBeNull(); // index order was honoured
  });

  it('carries the measured verdict, severity, defects, lineage and hash', () => {
    const d = buildLegoDiagnostics({ models: MODELS, loadedIndex: 0, now: 'x' }) as
      Record<string, Record<string, unknown>>;
    const loaded = d['source']!['loaded'] as Record<string, unknown>;
    expect(loaded['assembly']).toBe('defective');
    expect(loaded['severity']).toBe(12.5);
    expect(loaded['defects']).toEqual(['overlap 2.1 % of parts']);
    expect(loaded['lineage']).toBe('mb_align v2 good');
    expect(loaded['hash']).toBe('aabbccddeeff');
  });

  it('reports an ungraded source as unverified, not as clean', () => {
    const d = buildLegoDiagnostics({ models: MODELS, loadedIndex: 1, now: 'x' }) as
      Record<string, Record<string, unknown>>;
    const loaded = d['source']!['loaded'] as Record<string, unknown>;
    expect(loaded['assembly']).toBe('unverified');
    expect(loaded['severity']).toBeUndefined();
    expect(loaded['defects']).toBeUndefined();
    expect((d['notes'] as string[]).join(' ')).toMatch(/not a defect claim/);
  });

  it('survives a load with no index entry at all (upload / OMR chain)', () => {
    const d = buildLegoDiagnostics({
      setNum: '10030-1', fallbackLoader: 'omr-chain',
      sourceUrl: '/ldraw-omr/10030-1.mpd', now: 'x',
      render: { mode: 'direct-3d', bricks: 3441 },
    }) as Record<string, Record<string, unknown>>;
    expect(d['source']!['loader']).toBe('omr-chain');
    expect(d['source']!['intended']).toBeNull();
    expect(d['source']!['available']).toBeNull();
    expect(d['source']!['pickReason']).toBeNull();
    expect(d['render']!['bricks']).toBe(3441);
  });

  it('reports absent measurements as null rather than zero', () => {
    const d = buildLegoDiagnostics({ now: 'x' }) as Record<string, Record<string, unknown>>;
    expect(d['render']!['bricks']).toBeNull();
    expect(d['render']!['explodeFactor']).toBeNull();
    expect(d['mapping']!['lddPartMapEntries']).toBeNull();
    expect(d['contactAudit']).toBeNull();
    // empty arrays ARE meaningful (the viewer reported no missing parts)
    expect(d['parts']!['missing']).toEqual([]);
  });

  it('records the index + geograde provenance the grades came from', () => {
    const d = buildLegoDiagnostics({ index: IDX, now: 'x' }) as
      Record<string, Record<string, unknown>>;
    expect(d['index']!['generated']).toBe('2026-09-09');
    expect(d['index']!['schema']).toBe(2);
    expect((d['index']!['geograde'] as Record<string, unknown>)['stale']).toBe(2749);
  });

  it('defaults schema to 1 for a pre-metadata index', () => {
    const d = buildLegoDiagnostics({ index: { generated: 'old', sets: {} }, now: 'x' }) as
      Record<string, Record<string, unknown>>;
    expect(d['index']!['schema']).toBe(1);
  });

  it('is JSON-serializable verbatim', () => {
    const d = buildLegoDiagnostics({ models: MODELS, loadedIndex: 0, now: 'x' });
    const round = JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
    expect(round['kind']).toBe('craftmatic-lego-diagnostics');
    expect(round['generated']).toBe('x');
  });
});

describe('diagnosticsFilename', () => {
  it('names the file by set and day', () => {
    expect(diagnosticsFilename('10316-1', new Date('2026-09-09T12:00:00Z')))
      .toBe('craftmatic-diag-10316-1-2026-09-09.json');
    expect(diagnosticsFilename(undefined, new Date('2026-09-09T12:00:00Z')))
      .toBe('craftmatic-diag-2026-09-09.json');
  });
});
