/**
 * Best-source resolution for the unified models index (offline, synthetic index).
 *
 * Regressions guarded:
 *  1. The search source-filter must match the set's BEST source (what the
 *     indexed auto-load resolves first), not "any entry in the index" —
 *     71040-1 has a pdf_recon fallback but loads its mecabricks model, so it
 *     must NOT appear under the "Vision recon" filter.
 *  2. Default (relevance) ordering must stably partition by source quality:
 *     authentic → conversion → recon → unindexed, preserving rankSets' order
 *     inside each class.
 */

import { describe, it, expect } from 'vitest';
import {
  bestIndexedModel, indexedTryOrder, lookupIndexModels, sourceClass,
  bestSourceClass, sortByBestSourceClass, SOURCE_GROUPS, sourceBadgeLabel,
  type IndexModel, type LegoModelsIndex,
} from '../web/src/engine/lego-sources.js';

const M = (src: string, path: string, extra: Partial<IndexModel> = {}): IndexModel =>
  ({ src, path, tier: 1, steps: 0, n: 100, ...extra });

const IDX: LegoModelsIndex = {
  generated: 'test',
  sets: {
    // The real shape of the reported bug: mecabricks best, recon fallback.
    '71040': { name: 'Disney Castle', year: '2016', parts: 4081, models: [
      M('mecabricks', 'MecabricksLDR/71040.ldr'),
      M('pdf_recon', 'Reconstructed/71040_reconstructed.ldr', { tier: 2 }),
    ] },
    '21063': { name: 'Neuschwanstein', year: '2025', parts: 3455, models: [
      M('io', 'IO/21063.io'),
      M('recon_v3', 'Reconstructed/21063_reconstructed.ldr', { tier: 2 }),
    ] },
    '10001': { name: 'Train', year: '1999', parts: 700, models: [
      M('omr', 'OMR/10001-1.mpd'),
    ] },
    // conv-flagged top entry → auto-load (and therefore the filter/badge)
    // prefers the first non-conv source.
    '60502': { name: 'Convy', year: '2024', parts: 900, models: [
      M('lxf_conv', 'LXFCONV/60502.ldr', { conv: 1 }),
      M('dbix_conv_v2', 'DBIX/60502.ldr'),
    ] },
    // every entry conv-flagged → order unchanged
    '99999': { name: 'All conv', year: '2000', parts: 10, models: [
      M('lxf_conv', 'a.ldr', { conv: 1 }),
      M('lxf_conv', 'b.ldr', { conv: 1 }),
    ] },
    // suffix-variant floating
    '10002': { name: 'Variants', year: '2001', parts: 50, models: [
      M('omr', 'OMR/10002-1.mpd'),
      M('io', 'IO/10002-2.io'),
    ] },
  },
};

describe('bestIndexedModel — the source auto-load actually resolves', () => {
  it('is the first indexed entry', () => {
    expect(bestIndexedModel(IDX, '71040-1')?.src).toBe('mecabricks');
    expect(bestIndexedModel(IDX, '21063-1')?.src).toBe('io');
  });

  it('skips a conv-flagged top entry when a non-conv source exists', () => {
    expect(indexedTryOrder(IDX.sets['60502']!.models)).toEqual([1, 0]);
    expect(bestIndexedModel(IDX, '60502-1')?.src).toBe('dbix_conv_v2');
  });

  it('keeps order when every entry is conv-flagged', () => {
    expect(indexedTryOrder(IDX.sets['99999']!.models)).toEqual([0, 1]);
    expect(bestIndexedModel(IDX, '99999-1')?.src).toBe('lxf_conv');
  });

  it('floats suffix-matching variants to the front', () => {
    expect(lookupIndexModels(IDX, '10002-2')!.map(m => m.path))
      .toEqual(['IO/10002-2.io', 'OMR/10002-1.mpd']);
    expect(bestIndexedModel(IDX, '10002-2')?.src).toBe('io');
    expect(bestIndexedModel(IDX, '10002-1')?.src).toBe('omr');
  });

  it('returns null for unindexed sets', () => {
    expect(bestIndexedModel(IDX, '00000-1')).toBeNull();
    expect(bestSourceClass(IDX, '00000-1')).toBe('unindexed');
  });
});

describe('source filter — best source only', () => {
  const matches = (group: string, setNum: string): boolean => {
    const best = bestIndexedModel(IDX, setNum);
    return best != null && SOURCE_GROUPS[group]!(best.src);
  };

  it('does NOT list 71040 under "recon" (its recon entry is a never-used fallback)', () => {
    expect(matches('recon', '71040-1')).toBe(false);
    expect(matches('mecabricks', '71040-1')).toBe(true);
  });

  it('does NOT list 21063 under "recon" either', () => {
    expect(matches('recon', '21063-1')).toBe(false);
    expect(matches('io', '21063-1')).toBe(true);
  });

  it('matches io_model2* variants under the io group', () => {
    expect(SOURCE_GROUPS['io']!('io_model2_v2')).toBe(true);
    expect(SOURCE_GROUPS['omr']!('ldr')).toBe(true);
    expect(SOURCE_GROUPS['lxf']!('lxf_conv')).toBe(true);
    expect(SOURCE_GROUPS['mecabricks']!('mecabricks_search')).toBe(true);
  });
});

describe('sourceClass', () => {
  it('classifies authentic build files', () => {
    for (const s of ['io', 'io_model2', 'io_model2_v2', 'omr', 'ldr'])
      expect(sourceClass(s)).toBe('authentic');
  });
  it('classifies conversions', () => {
    for (const s of ['mecabricks', 'mecabricks_search', 'dbix_conv', 'dbix_conv_v2',
                     'dbix_assetbundle', 'lxf', 'lxf_conv', 'eurobricks'])
      expect(sourceClass(s)).toBe('conversion');
  });
  it('classifies reconstructions', () => {
    for (const s of ['recon_v3', 'pdf_recon']) expect(sourceClass(s)).toBe('recon');
  });
});

describe('sortByBestSourceClass — stable quality partition', () => {
  it('puts authentic first, then conversions, then recon, then unindexed', () => {
    const list = [
      { set_num: '71040-1' }, // mecabricks → conversion
      { set_num: '00000-1' }, // unindexed
      { set_num: '21063-1' }, // io → authentic
      { set_num: '60502-1' }, // dbix_conv_v2 → conversion
      { set_num: '10001-1' }, // omr → authentic
    ];
    sortByBestSourceClass(list, IDX);
    expect(list.map(s => s.set_num))
      .toEqual(['21063-1', '10001-1', '71040-1', '60502-1', '00000-1']);
  });

  it('preserves the incoming (flagship) order inside each class', () => {
    const list = [
      { set_num: '10001-1' }, // authentic, 2nd in the previous test
      { set_num: '21063-1' }, // authentic
      { set_num: '60502-1' }, // conversion
      { set_num: '71040-1' }, // conversion
    ];
    sortByBestSourceClass(list, IDX);
    expect(list.map(s => s.set_num))
      .toEqual(['10001-1', '21063-1', '60502-1', '71040-1']);
  });

  it('is a no-op on a list that is already class-ordered', () => {
    const list = [{ set_num: '21063-1' }, { set_num: '71040-1' }, { set_num: '00000-1' }];
    const before = list.map(s => s.set_num);
    sortByBestSourceClass(list, IDX);
    expect(list.map(s => s.set_num)).toEqual(before);
  });
});

describe('sourceBadgeLabel', () => {
  it('shortens source ids for the card badge', () => {
    expect(sourceBadgeLabel('io_model2_v2')).toBe('io');
    expect(sourceBadgeLabel('mecabricks')).toBe('meca');
    expect(sourceBadgeLabel('dbix_conv_v2')).toBe('dbix');
    expect(sourceBadgeLabel('pdf_recon')).toBe('recon');
    expect(sourceBadgeLabel('omr')).toBe('omr');
  });
});
