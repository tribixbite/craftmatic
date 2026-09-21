import { describe, expect, it } from 'vitest';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import { createPartGeometryProvider, normPartId, printBaseId } from '../web/src/engine/ldraw-part-geometry.js';

/** A tiny fake library: a 1×1 "brick" built from a box subpart plus one stud. */
const LIBRARY: Record<string, string> = {
  // A closed 20×24×20 box from y=0 (bottom) to y=-24 (top), as 6 quads.
  'box6': [
    '0 Box 6 faces',
    '4 16 -10 0 -10 10 0 -10 10 0 10 -10 0 10',
    '4 16 -10 -24 -10 10 -24 -10 10 -24 10 -10 -24 10',
    '4 16 -10 0 -10 -10 -24 -10 10 -24 -10 10 0 -10',
    '4 16 -10 0 10 -10 -24 10 10 -24 10 10 0 10',
    '4 16 -10 0 -10 -10 -24 -10 -10 -24 10 -10 0 10',
    '4 16 10 0 -10 10 -24 -10 10 -24 10 10 0 10',
  ].join('\n'),
  // A "brick" = the box + a top stud + an underside tube (skipped).
  '3005': [
    '0 Brick 1 x 1',
    '1 16 0 0 0 1 0 0 0 1 0 0 0 1 box6.dat',
    '1 16 0 -24 0 1 0 0 0 1 0 0 0 1 stud.dat',
    '1 16 0 0 0 1 0 0 0 1 0 0 0 1 stud4.dat',
  ].join('\n'),
  // A two-colour part: the box in the instance colour plus a red triangle "print".
  '3005p01': [
    '0 Brick 1 x 1 with red print',
    '1 16 0 0 0 1 0 0 0 1 0 0 0 1 box6.dat',
    '3 4 -5 -5 -10.01 5 -5 -10.01 0 -15 -10.01',
  ].join('\n'),
  // A part whose child is placed with an explicit colour: its 16s become that colour.
  'twotone': [
    '0 Two-tone',
    '1 2 0 0 0 1 0 0 0 1 0 0 0 1 box6.dat',
  ].join('\n'),
  // A rotated, translated sub-reference (90° about Y, moved +40 in X).
  'nested': [
    '0 Nested',
    '1 16 40 0 0 0 0 1 0 1 0 -1 0 0 3005.dat',
  ].join('\n'),
  // Cycle: a → b → a.
  'cyc_a': '0 A\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 cyc_b.dat\n3 16 0 0 0 1 0 0 0 0 1',
  'cyc_b': '0 B\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 cyc_a.dat',
  // Holes: a reference that resolves nowhere.
  'holey': '0 Holey\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 box6.dat\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 nothere.dat',
  // TEXMAP fallback geometry must count as geometry.
  'texmapped': [
    '0 Texmapped',
    '0 !TEXMAP START PLANAR 0 0 0 1 0 0 0 1 0 tex.png',
    '0 !: 4 16 -10 0 -10 10 0 -10 10 0 10 -10 0 10',
    '0 !TEXMAP END',
  ].join('\n'),
};

const fetchPartText = async (id: string): Promise<string | null> => {
  const key = id.replace(/^.*\//, '');
  return LIBRARY[key] ?? null;
};

describe('createPartGeometryProvider', () => {
  it('normalizes Studio inherited colours through triangles, quads and child references', async () => {
    const provider = createPartGeometryProvider({ fetchPartText: async (id) => id === 'studio'
      ? '3 -1 0 0 0 1 0 0 0 1 0\n4 -1 0 0 0 1 0 0 1 1 0 0 1 0\n1 -1 0 0 0 1 0 0 0 1 0 0 0 1 child.dat'
      : id === 'child' ? '3 -1 0 0 1 1 0 1 0 1 1' : null });
    const mesh = await provider.getPartMesh('studio');
    expect(mesh?.triangles).toHaveLength(4);
    expect(mesh?.triangles.every(triangle => triangle.color === 16)).toBe(true);
  });

  it('resolves nested sub-file references with transforms, quads as two triangles, colour 16 symbolic', async () => {
    const provider = createPartGeometryProvider({ fetchPartText });
    const brick = await provider.getPartMesh('3005.dat');
    expect(brick).not.toBeNull();
    expect(brick!.triangles).toHaveLength(12); // 6 quads → 12 triangles; stud + tube contribute none
    expect(brick!.triangles.every(t => t.color === 16)).toBe(true);
    expect(brick!.bounds).toEqual({ min: [-10, -24, -10], max: [10, 0, 10] });
    expect(brick!.studs).toEqual([{ center: [0, -24, 0], up: [0, -1, 0], radius: 6, height: 4 }]);

    const nested = await provider.getPartMesh('nested');
    // The 3005 inside is rotated 90° about Y and moved +40 in X: its x∈[-10,10] becomes x∈[30,50].
    expect(nested!.bounds.min[0]).toBeCloseTo(30);
    expect(nested!.bounds.max[0]).toBeCloseTo(50);
    expect(nested!.studs[0]!.center[0]).toBeCloseTo(40);
    expect(nested!.studs[0]!.up).toEqual([0, -1, 0]);
  });

  it('keeps explicit colours and applies a reference colour to its children', async () => {
    const provider = createPartGeometryProvider({ fetchPartText });
    const printed = await provider.getPartMesh('3005p01');
    expect(printed!.printFallback).toBeUndefined();
    expect(printed!.triangles.filter(t => t.color === 4)).toHaveLength(1);
    expect(printed!.triangles.filter(t => t.color === 16)).toHaveLength(12);

    const twotone = await provider.getPartMesh('twotone');
    expect(twotone!.triangles.every(t => t.color === 2)).toBe(true);
  });

  it('falls back to the unprinted base for a missing printed id and records it', async () => {
    const provider = createPartGeometryProvider({ fetchPartText });
    const mesh = await provider.getPartMesh('3005p99.dat');
    expect(mesh).not.toBeNull();
    expect(mesh!.partId).toBe('3005p99');
    expect(mesh!.resolvedAs).toBe('3005');
    expect(mesh!.printFallback).toBe('3005');
    expect(provider.report().printFallbacks).toEqual([{ part: '3005p99', base: '3005' }]);
  });

  it('returns null for a missing part and lists it; a missing sub-reference is a recorded hole', async () => {
    const provider = createPartGeometryProvider({ fetchPartText });
    expect(await provider.getPartMesh('99999')).toBeNull();
    expect(provider.report().unresolved).toEqual(['99999']);
    const holey = await provider.getPartMesh('holey');
    expect(holey!.triangles).toHaveLength(12);
    expect(holey!.unresolvedRefs).toEqual(['nothere']);
  });

  it('survives a reference cycle', async () => {
    const provider = createPartGeometryProvider({ fetchPartText });
    const a = await provider.getPartMesh('cyc_a');
    expect(a).not.toBeNull();
    expect(a!.triangles.length).toBeGreaterThanOrEqual(1);
  });

  it('prefers an embedded document section over the library, by name and by stem', async () => {
    const doc = parseLDrawDocument([
      '0 FILE main.ldr',
      '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3005.dat',
      '0 FILE 3005.dat',
      '0 !LDRAW_ORG Unofficial_Part',
      '3 16 0 0 0 30 0 0 0 0 30',
    ].join('\n'));
    const provider = createPartGeometryProvider({ document: doc, fetchPartText });
    const mesh = await provider.getPartMesh('3005');
    expect(mesh!.triangles).toHaveLength(1);
    expect(mesh!.bounds.max).toEqual([30, 0, 30]);
    // A path-qualified embedded name resolves by its stem too.
    const doc2 = parseLDrawDocument('0 FILE main.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 s\\weird.dat\n0 FILE s\\weird.dat\n0 !LDRAW_ORG Unofficial_Subpart\n3 16 0 0 0 5 0 0 0 0 5');
    const provider2 = createPartGeometryProvider({ document: doc2, fetchPartText });
    expect((await provider2.getPartMesh('weird.dat'))!.triangles).toHaveLength(1);
  });

  it('uses TEXMAP fallback lines as geometry', async () => {
    const provider = createPartGeometryProvider({ fetchPartText });
    expect((await provider.getPartMesh('texmapped'))!.triangles).toHaveLength(2);
  });

  it('caches by normalised id (one build per part)', async () => {
    let calls = 0;
    const provider = createPartGeometryProvider({ fetchPartText: async id => { calls++; return fetchPartText(id); } });
    await Promise.all([provider.getPartMesh('3005.dat'), provider.getPartMesh('3005'), provider.getPartMesh('3005.DAT')]);
    expect(calls).toBe(2); // 3005 + box6, each fetched once
  });
});

describe('id helpers', () => {
  it('normalises ids like the voxelizer', () => {
    expect(normPartId('S\\3001S01.DAT')).toBe('s/3001s01');
    expect(normPartId(' 3001.dat ')).toBe('3001');
  });
  it('derives print bases without shredding primitive names', () => {
    expect(printBaseId('3010p01')).toBe('3010');
    expect(printBaseId('4215ap01')).toBe('4215a');
    expect(printBaseId('s/3626bp01')).toBe('s/3626b');
    expect(printBaseId('npeghol2')).toBeNull();
    expect(printBaseId('3001')).toBeNull();
  });
});
