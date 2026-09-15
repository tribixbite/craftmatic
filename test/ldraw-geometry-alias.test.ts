/**
 * The export/entity part resolver (`engine/ldraw-geometry.ts`) must reach the
 * same names the viewer does: after a definitive library miss it walks the
 * alias ladder (`6538c` → `6538`) and records the substitution, so a CLI or
 * Worker export of a model the viewer rendered whole does not grow holes.
 * Offline: a temp library on disk, the prod mirror disabled.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { datSubstitutionFor, getDatText, setLDrawMirror, setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { partAliasCandidates } from '../web/src/engine/ldraw-part-aliases.js';

const BRICK = ['0 Brick 1 x 1', '4 16 -10 -24 -10 10 -24 -10 10 -24 10 -10 -24 10', '4 16 -10 0 -10 10 0 -10 10 0 10 -10 0 10'].join('\n');

describe('export resolver alias ladder', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'craftmatic-ldraw-'));
    mkdirSync(join(root, 'parts'), { recursive: true });
    mkdirSync(join(root, 'p'), { recursive: true });
    writeFileSync(join(root, 'parts', '6538.dat'), BRICK);
    writeFileSync(join(root, 'parts', '3626a.dat'), BRICK);
    setLDrawRoot(root);
    setLDrawMirror(null);
  });
  afterAll(() => { setLDrawMirror('https://craftmatic.click/ldraw-parts'); });

  it('is the same ladder the viewer uses', () => {
    expect(partAliasCandidates('6538c')).toEqual(['6538']);
    expect(partAliasCandidates('3626ad1024')).toEqual(['3626a', '3626']); // chained: decoration, then the mould letter
    expect(partAliasCandidates('stud4')).toEqual([]);
  });

  it('serves a lettered mould revision from its base and records the stand-in', async () => {
    expect(await getDatText('6538c')).toBe(BRICK);
    expect(datSubstitutionFor('6538c')).toBe('6538');
    expect(datSubstitutionFor('6538')).toBeUndefined();
  });

  it('walks chained suffixes and reports the substitution through the geometry provider', async () => {
    const provider = createPartGeometryProvider();
    const mesh = await provider.getPartMesh('3626ad1024');
    expect(mesh).not.toBeNull();
    expect(mesh!.triangles).toHaveLength(4);
    expect(provider.report().substitutions).toEqual([{ part: '3626ad1024', alias: '3626a' }]);
    expect(provider.report().unresolved).toEqual([]);
  });

  it('still reports a name nothing resolves as unresolved, never as a silent box', async () => {
    expect(await getDatText('x346')).toBeNull();
    expect(datSubstitutionFor('x346')).toBeUndefined();
    const provider = createPartGeometryProvider();
    expect(await provider.getPartMesh('x346')).toBeNull();
    expect(provider.report().unresolved).toEqual(['x346']);
  });

  it('never applies the ladder to a primitive path', async () => {
    expect(await getDatText('s/6538cs01')).toBeNull();
    expect(datSubstitutionFor('s/6538cs01')).toBeUndefined();
  });
});
