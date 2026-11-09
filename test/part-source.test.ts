/**
 * Part-source ledger and official-only library mode (BIZ-07 / X-04).
 * Fixtures are a tiny library in a temp folder; real-library checks are gated on the corpus being present.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertOfficialLibrary, datSubstitutionFor, getDatText, getPartSourceLedger, libraryRelPathsFor,
  setLDrawLibraryMode, setLDrawMirror, setLDrawRoot,
} from '../web/src/engine/ldraw-geometry.js';
import { licenceGate, OfficialLibraryError, type PartSourceEntry } from '../web/src/engine/part-source.js';

const REAL_REF = 'C:/git/clego/ldraw_ref/official';
const STUDIO_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';

const BRICK = (extra: string[] = []): string => [
  '0 Brick 1 x 1', '0 Name: x.dat', '0 Author: Fixture Author', '0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt',
  '4 16 -10 -24 -10 10 -24 -10 10 -24 10 -10 -24 10', ...extra,
].join('\n');

describe('part-source ledger and official library mode', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'craftmatic-x04-'));
    for (const d of ['parts', 'parts/s', 'p', 'UnOfficial/parts']) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, 'parts', '3001.dat'), BRICK(['1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\3001s01.dat', '1 16 0 0 0 1 0 0 0 1 0 0 0 1 stud.dat']));
    writeFileSync(join(root, 'parts', 's', '3001s01.dat'), BRICK());
    writeFileSync(join(root, 'p', 'stud.dat'), BRICK());
    writeFileSync(join(root, 'p', 'stud-logo.dat'), BRICK());
    writeFileSync(join(root, 'p', 'logo3.dat'), BRICK());
    // A part whose official mould only exists under a lettered sibling: the dev ladder would serve 6538c from 6538.
    writeFileSync(join(root, 'parts', '6538.dat'), BRICK());
    writeFileSync(join(root, 'UnOfficial', 'parts', '99999.dat'), BRICK());
    writeFileSync(join(root, 'UnOfficial', 'parts', 'bl_3001.dat'), BRICK());
    setLDrawRoot(root);
    setLDrawMirror(null);
  });
  beforeEach(() => setLDrawLibraryMode('official'));
  afterAll(() => { setLDrawLibraryMode(null); setLDrawMirror('https://craftmatic.click/ldraw-parts'); });

  it('in official mode a part present only in Studio\'s UnOfficial tree fails the export with its name', async () => {
    expect(await getDatText('99999')).toBeNull();
    expect(() => assertOfficialLibrary(['99999'])).toThrowError(OfficialLibraryError);
    try { assertOfficialLibrary(['99999']); } catch (e) {
      expect((e as OfficialLibraryError).violations).toEqual([{ part: '99999', reason: 'not-in-official-tree' }]);
      expect((e as Error).message).toContain('99999');
    }
  });

  it('an official part resolves through its subfiles and the gate passes', async () => {
    expect(await getDatText('3001')).not.toBeNull();
    await getDatText('s/3001s01'); await getDatText('stud');
    expect(() => assertOfficialLibrary(['3001'])).not.toThrow();
    const ledger = getPartSourceLedger(['3001']);
    expect(ledger.map(e => `${e.part}:${e.kind}:${e.file}`).sort()).toEqual([
      '3001:ldraw-official:parts/3001.dat', 's/3001s01:ldraw-official:parts/s/3001s01.dat', 'stud:ldraw-official:p/stud.dat',
    ]);
    expect(licenceGate(ledger).ok).toBe(true);
  });

  it('a bl_ copy is refused even when the file exists in Studio\'s tree', async () => {
    expect(await getDatText('bl_3001')).toBeNull();
    expect(() => assertOfficialLibrary(['bl_3001'])).toThrowError(/bl_3001/);
  });

  it('datSubstitutions stays empty in official mode', async () => {
    expect(await getDatText('6538c')).toBeNull(); // dev mode serves this from 6538
    expect(datSubstitutionFor('6538c')).toBeUndefined();
    expect(() => assertOfficialLibrary(['6538c'])).toThrowError(/6538c/);
  });

  it('a logo stud primitive reached through a part is refused in official mode', async () => {
    expect(await getDatText('stud-logo')).toBeNull();
    expect(await getDatText('logo3')).toBeNull();
    try { assertOfficialLibrary(['stud-logo', 'logo3']); expect.unreachable(); } catch (e) {
      expect((e as OfficialLibraryError).violations.map(v => v.reason)).toEqual(['logo-primitive', 'logo-primitive']);
    }
  });

  it('official 3001.dat records "Licensed under CC BY 4.0" and author James Jessiman', async () => {
    if (!existsSync(`${REAL_REF}/parts/3001.dat`)) return;
    // The real tree, through the local mirror copy (`ldraw_ref/`), not the fixture.
    const prev = process.env['CRAFTMATIC_LDRAW_REF'];
    const empty = mkdtempSync(join(tmpdir(), 'craftmatic-x04-empty-'));
    process.env['CRAFTMATIC_LDRAW_REF'] = 'C:/git/clego/ldraw_ref';
    try {
      setLDrawRoot(empty);
      setLDrawLibraryMode('official');
      await getDatText('3001');
      const [entry] = getPartSourceLedger(['3001']);
      expect(entry?.kind).toBe('ldraw-official');
      expect(entry?.licence).toContain('Licensed under CC BY 4.0');
      expect(entry?.author).toBe('James Jessiman');
    } finally {
      if (prev === undefined) delete process.env['CRAFTMATIC_LDRAW_REF']; else process.env['CRAFTMATIC_LDRAW_REF'] = prev;
      setLDrawRoot(root);
    }
  });

  it('the licence gate names studio, mirror, custom and substituted entries as offending', () => {
    const base = { licence: 'Licensed under CC BY 4.0', author: 'A' };
    const mk = (kind: PartSourceEntry['kind'], extra: Partial<PartSourceEntry> = {}): PartSourceEntry => ({ part: kind, kind, file: 'x', ...base, ...extra });
    const ledger = [mk('ldraw-official'), mk('ldraw-unofficial'), mk('studio'), mk('mirror'), mk('custom'), mk('substituted', { origin: 'ldraw-official' }),
      mk('ldraw-unofficial', { part: 'nolicence', licence: null }), mk('ldraw-official', { part: 'nonfree', licence: 'All rights reserved' })];
    const gate = licenceGate(ledger);
    expect(gate.ok).toBe(false);
    expect(gate.offending.map(e => e.part)).toEqual(['studio', 'mirror', 'custom', 'substituted', 'nolicence', 'nonfree']);
  });
});

describe('the dev mode is unchanged', () => {
  beforeAll(() => { setLDrawLibraryMode('dev'); });
  afterAll(() => { setLDrawLibraryMode(null); });

  it('probes the same relative paths, in the same order, as before X-04', () => {
    expect(libraryRelPathsFor('3001')).toEqual(['parts/3001.dat', 'p/3001.dat', 'parts/s/3001.dat', 'UnOfficial/parts/3001.dat', 'UnOfficial/p/3001.dat', 'UnOfficial/parts/s/3001.dat']);
    expect(libraryRelPathsFor('s/3001s01')).toEqual(['parts/s/3001s01.dat', 'UnOfficial/parts/s/3001s01.dat',
      'parts/3001s01.dat', 'p/3001s01.dat', 'parts/s/3001s01.dat', 'UnOfficial/parts/3001s01.dat', 'UnOfficial/p/3001s01.dat', 'UnOfficial/parts/s/3001s01.dat']);
    expect(libraryRelPathsFor('48/4-4edge')).toEqual(['p/48/4-4edge.dat', 'UnOfficial/p/48/4-4edge.dat',
      'parts/4-4edge.dat', 'p/4-4edge.dat', 'parts/s/4-4edge.dat', 'UnOfficial/parts/4-4edge.dat', 'UnOfficial/p/4-4edge.dat', 'UnOfficial/parts/s/4-4edge.dat']);
  });

  it('resolves the same file as before for 3001, 3626 and a subpart', async () => {
    if (!existsSync(`${STUDIO_ROOT}/parts/3001.dat`)) return;
    setLDrawRoot(STUDIO_ROOT);
    setLDrawMirror(null);
    for (const [id, rel] of [['3001', 'parts/3001.dat'], ['3626', 'parts/3626.dat'], ['s/3001s01', 'parts/s/3001s01.dat']] as const) {
      expect(await getDatText(id)).toBe(readFileSync(`${STUDIO_ROOT}/${rel}`, 'utf-8'));
      expect(getPartSourceLedger([id])[0]?.file).toBe(rel);
    }
    setLDrawMirror('https://craftmatic.click/ldraw-parts');
  });
});
