import { describe, it, expect } from 'vitest';
import { applyFilter, flattenIndex, parseSetTokens, resolveItems, rowToItem, srcClasses, type RawIndex } from './index-store.ts';

const RAW: RawIndex = {
  generated: '2026-09-20', schema: 2,
  sets: {
    '10001': { name: 'Metroliner', year: '2001', parts: 787, models: [
      { src: 'ldr', path: 'LDR/10001 Metro Liner.ldr', tier: 1, steps: 0, n: 720, hash: '5a9f0a1dad4d', asm: 'verified', sev: 0.07 },
      { src: 'omr', path: 'OMR/10001-1.mpd', tier: 1, steps: 7, n: 872, hash: '684a8032488d', asm: 'verified', sev: 0.07 },
      { src: 'omr', path: 'OMR/10001-1_B-Model.mpd', tier: 1, steps: 24, n: 724, hash: 'a300b85405ac', asm: 'verified', sev: 0, variant: 'B-Model' },
    ] },
    '71043': { name: 'Hogwarts Castle', year: 2018, parts: 6020, models: [
      { src: 'lxf', path: 'LXF/71043_hogwarts_castle.lxf', tier: 1, steps: 0, n: 5967, hash: '479bdba847f9', asm: 'defective', sev: 0, defects: ['figures: 5 assembly defects'] },
      { src: 'lxf_conv', path: 'LDR/71043_hogwarts_castle.ldr', tier: 1, steps: 0, n: 5936, hash: '169b146d158f', asm: 'defective', sev: 1, defects: ['figures: 1 assembly defects'], conv: 1 },
    ] },
    '76416': { name: 'Quidditch Trunk', year: '2023', parts: 599, models: [
      { src: 'io', path: 'IO/76416-1.io', tier: 1, steps: 0, n: 590, hash: 'abcabcabcabc' },
      { src: 'recon_v3', path: 'ReconV3/76416.ldr', tier: 2, steps: 0, n: 400, hash: 'cdcdcdcdcdcd', asm: 'defective', sev: 12.5, defects: ['windows: 2 panes off frame'] },
    ] },
  },
};
const rows = flattenIndex(RAW);

describe('flattenIndex', () => {
  it('yields one row per model entry with the set repeated and rank recorded', () => {
    expect(rows.length).toBe(7);
    expect(rows.filter(r => r.set === '10001').map(r => r.rank)).toEqual([0, 1, 2]);
    expect(rows[0]).toMatchObject({ set: '10001', name: 'Metroliner', year: 2001, parts: 787, src: 'ldr', asm: 'verified', conv: false, variant: null });
  });
  it('treats an absent asm as unverified and an absent sev as 0', () => {
    const io = rows.find(r => r.src === 'io')!;
    expect(io.asm).toBe('unverified');
    expect(io.sev).toBe(0);
  });
  it('coerces string years', () => { expect(rows.find(r => r.set === '76416')!.year).toBe(2023); });
});

describe('applyFilter', () => {
  it('matches everything when empty', () => { expect(applyFilter(rows, {}).length).toBe(7); });
  it('primaryOnly keeps models[0] of each set', () => { expect(applyFilter(rows, { primaryOnly: true }).map(r => r.set)).toEqual(['10001', '71043', '76416']); });
  it('set tokens match exactly or by prefix', () => {
    expect(applyFilter(rows, { sets: '71043' }).length).toBe(2);
    expect(applyFilter(rows, { sets: '7' }).map(r => r.set)).toEqual(['71043', '71043', '76416', '76416']);
    expect(parseSetTokens('71043, 10001;7')).toEqual(['71043', '10001', '7']);
  });
  it('filters by src, asm, sev, tier, year, parts, name, defect and free text', () => {
    expect(applyFilter(rows, { src: ['omr'] }).length).toBe(2);
    expect(applyFilter(rows, { asm: 'defective' }).length).toBe(3);
    expect(applyFilter(rows, { asm: 'verified', sevMax: 0 }).map(r => r.path)).toEqual(['OMR/10001-1_B-Model.mpd']);
    expect(applyFilter(rows, { tier: 2 }).map(r => r.src)).toEqual(['recon_v3']);
    expect(applyFilter(rows, { yearMin: 2018, yearMax: 2020 }).every(r => r.set === '71043')).toBe(true);
    expect(applyFilter(rows, { partsMin: 1000 }).every(r => r.set === '71043')).toBe(true);
    expect(applyFilter(rows, { name: 'hogwarts' }).length).toBe(2);
    expect(applyFilter(rows, { hasDefect: 'window' }).map(r => r.src)).toEqual(['recon_v3']);
    expect(applyFilter(rows, { text: 'b-model' }).length).toBe(1);
    expect(applyFilter(rows, { sevMin: 10 }).length).toBe(1);
  });
  it('applies the limit after every other clause', () => { expect(applyFilter(rows, { asm: 'defective', limit: 2 }).length).toBe(2); });
});

describe('srcClasses / rowToItem', () => {
  it('counts classes descending', () => { expect(srcClasses(rows)[0]).toEqual({ src: 'omr', n: 2 }); });
  it('builds an item with the corpus path and a rank-qualified id', () => {
    const it0 = rowToItem(rows[0]!), it1 = rowToItem(rows[1]!);
    expect(it0.id).toBe('10001');
    expect(it1.id).toBe('10001#1');
    expect(it1.model).toBe('C:/git/clego/lego_sets/OMR/10001-1.mpd');
    expect(it1.indexPath).toBe('OMR/10001-1.mpd');
  });
});

describe('resolveItems', () => {
  it('resolves set numbers to the primary pick, with or without a revision suffix', () => {
    const r = resolveItems(rows, [{ set: '71043' }, { set_num: '10001-1' }]);
    expect(r.items.map(i => i.indexPath)).toEqual(['LXF/71043_hogwarts_castle.lxf', 'LDR/10001 Metro Liner.ldr']);
    expect(r.unresolved).toEqual([]);
  });
  it('resolves an index path to that exact entry, case-insensitively and with backslashes', () => {
    const r = resolveItems(rows, [{ path: 'omr\\10001-1_b-model.mpd' }]);
    expect(r.items[0]!.id).toBe('10001#2');
  });
  it('accepts an absolute or corpus-relative path that is not indexed, and packs', () => {
    const r = resolveItems(rows, [{ path: 'D:/x/thing.io' }, { path: 'IO/other.io', set: '9999-1' }, { pack: 'C:/p/a.mcaddon' }]);
    expect(r.items[0]).toMatchObject({ model: 'D:/x/thing.io' });
    expect(r.items[1]).toMatchObject({ model: 'C:/git/clego/lego_sets/IO/other.io', set: '9999' });
    expect(r.items[2]).toMatchObject({ pack: 'C:/p/a.mcaddon', id: 'a.mcaddon' });
  });
  it('keeps an unknown set as a bare set item, reports rows with nothing usable, and de-duplicates', () => {
    const r = resolveItems(rows, [{ set: '12345' }, { name: 'nothing' }, { set: '71043' }, { set: '71043' }]);
    expect(r.items.map(i => i.id)).toEqual(['12345', '71043']);
    expect(r.items[0]!.model).toBeUndefined();
    expect(r.unresolved.length).toBe(1);
  });
});
