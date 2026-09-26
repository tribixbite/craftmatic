/**
 * Accurate faces (2026-09-24): a decorated LXFML head becomes its printed
 * LDraw part (`printedHeadFor`, `ldd-print-map.json`), and a printed head's
 * face - or seeded face art for a head no library prints - is drawn as a
 * TEXTURE on one decal cube (`head-face.ts`) instead of 2 LDU cuboids.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearFaceArt, faceArtImage, headBodyRect, orientFace, packFaceAtlas, photoSkinColour, rasterizeHeadFace, seedFaceArt,
  type FaceImage,
} from '../web/src/engine/head-face.js';
import {
  HEAD_DESIGNS, buildLxfPlacements, decorationIdOf, describeLxfDiagnostics, printedHeadFor, validatePrintRow, validateTable,
  type LxfAlignmentTable, type LxfMeasuredTable, type LxfPartRecord, type LxfPrintTable,
} from '../web/src/engine/lxf-parser.js';
import type { LdrawPartMesh, LdrawTriangle, Vec3 } from '../web/src/engine/ldraw-part-geometry.js';
import { resolveLdrawEntityMaterial } from '../web/src/engine/ldraw-entity-materials.js';

// ─── A synthetic head: a 26 x 24 x 26 box, front at z = −13 ─────────────────

const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, color: number): LdrawTriangle[] => [{ a, b, c, color }, { a, b: c, c: d, color }];
function headMesh(ink: LdrawTriangle[] = []): LdrawPartMesh {
  const x0 = -13, x1 = 13, y0 = 0, y1 = 24, z0 = -13, z1 = 13;
  const triangles: LdrawTriangle[] = [
    ...quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], 16), // front (−Z)
    ...quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], 16),
    ...quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], 16),
    ...quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], 16),
    ...quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], 16),
    ...quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], 16),
    ...ink,
  ];
  return { partId: 'head', resolvedAs: 'head', triangles, studs: [], bounds: { min: [x0, y0, z0], max: [x1, y1, z1] }, unresolvedRefs: [], description: 'Minifig Head' };
}
/** A black eye on the RIGHT half of the face-on image (LDraw +X), just proud of the front. */
const eye = quad([4, 8, -13.01], [8, 8, -13.01], [8, 12, -13.01], [4, 12, -13.01], 0);
/** A red print on the BACK face: never visible from the front. */
const backPrint = quad([-8, 8, 13.01], [8, 8, 13.01], [8, 12, 13.01], [-8, 12, 13.01], 4);

const texel = (img: FaceImage | { width: number; rgba: Uint8Array }, x: number, y: number): number[] => {
  const o = (y * img.width + x) * 4;
  return [...img.rgba.subarray(o, o + 4)];
};

describe('head-face: rasterising a printed head', () => {
  it('draws the front print where it is, keeps skin transparent and never shows a back print', () => {
    const img = rasterizeHeadFace(headMesh([...eye, ...backPrint]))!;
    expect(img).not.toBeNull();
    expect(img.rect).toEqual({ x0: -13, x1: 13, y0: 0, y1: 24 });
    expect(img.width).toBe(26 * 4);
    expect(img.height).toBe(24 * 4);
    // The eye's centre (x = 6, y = 10 LDU) -> texel (76, 40): black ink.
    expect(texel(img, 76, 40)).toEqual([...resolveLdrawEntityMaterial(0).rgb, 255]);
    // The mirror position (x = −6) is skin: transparent, although the back print covers it from behind.
    expect(texel(img, 28, 40)[3]).toBe(0);
    let ink = 0;
    for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i]) ink++;
    expect(ink).toBe(16 * 16); // the 4 x 4 LDU eye at 4 texels per LDU
  });

  it('returns null for a plain head', () => {
    expect(rasterizeHeadFace(headMesh())).toBeNull();
  });

  it('finds the head body between its stud and its neck', () => {
    // A stud (narrow, on top) and a neck (narrow, below) around the 26-wide body.
    const stud = quad([-6, -4, -13], [6, -4, -13], [6, 0, -13], [-6, 0, -13], 16);
    const mesh = headMesh(stud);
    mesh.bounds.min[1] = -4;
    const r = headBodyRect(mesh);
    expect(r.x0).toBeCloseTo(-13, 0); expect(r.x1).toBeCloseTo(13, 0);
    expect(r.y0).toBeGreaterThanOrEqual(-0.5); expect(r.y1).toBeCloseTo(24, 0);
  });
});

describe('head-face: face art', () => {
  afterEach(() => clearFaceArt());
  it('maps seeded art onto the head body by part name, ink opaque and the rest transparent', () => {
    const art = { width: 2, height: 1, rgba: new Uint8Array([200, 0, 0, 255, 0, 0, 0, 0]) };
    expect(seedFaceArt([['3626pb3484', art]])).toBe(1);
    // By the HEAD_PRINT id on a plain head, and by the older identity part name.
    expect(faceArtImage('3626c.dat', headMesh(), '3626pb3484')).not.toBeNull();
    expect(faceArtImage('3626c.dat', headMesh())).toBeNull();
    const img = faceArtImage('3626CPB3484', headMesh())!;
    expect(img.width).toBe(104);
    expect(texel(img, 10, 10)).toEqual([200, 0, 0, 255]);
    expect(texel(img, 90, 10)[3]).toBe(0);
    expect(faceArtImage('3626cpb9999', headMesh())).toBeNull();
  });

  it('drops a photo\'s own skin, so the head\'s swatch shows there instead of a mottle (Pixel 2026-09-25)', () => {
    // A 16 x 16 cut-out: shaded skin everywhere, two dark eyes, a transparent corner.
    const w = 16, rgba = new Uint8Array(w * w * 4);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, shade = (x + y) % 3 * 8;
      const eye = y >= 5 && y <= 6 && (x === 4 || x === 11);
      const corner = x < 2 && y < 2;
      rgba.set(eye ? [20, 15, 10, 255] : [214 - shade, 170 - shade, 130 - shade, corner ? 0 : 255], o);
    }
    seedFaceArt([['3626pb7777', { width: w, height: w, rgba }]]);
    const img = faceArtImage('3626c.dat', headMesh(), '3626pb7777')!;
    const alphaOf = (sx: number, sy: number): number => texel(img, Math.floor((sx + 0.5) / w * img.width), Math.floor((sy + 0.5) / w * img.height))[3]!;
    expect(alphaOf(4, 5)).toBe(255); // an eye is ink
    expect(alphaOf(8, 12)).toBe(0); // the cheek is the head's own colour now
    expect(photoSkinColour({ width: w, height: w, rgba })!.map(Math.round)).toEqual([206, 162, 122]);
  });

  it('refuses art whose pixels do not match its size', () => {
    expect(() => seedFaceArt([['x', { width: 2, height: 2, rgba: new Uint8Array(4) }]])).toThrow(/bytes/);
  });
});

describe('head-face: laying the print on a Bedrock cube face', () => {
  // A 2 x 1 image: left texel red, right texel blue.
  const img: FaceImage = { width: 2, height: 1, rgba: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]), rect: { x0: 0, x1: 2, y0: 0, y1: 1 } };
  it('reads unmirrored from outside: on the north face the image right runs along render −X', () => {
    const o = orientFace(img, [0, 0, -1], [-1, 0, 0], [0, -1, 0])!;
    expect(o.face).toBe('north');
    expect(texel(o, 0, 0)).toEqual([255, 0, 0, 255]);
    // The same print seen with its right along +X must be flipped to read the same way.
    const flipped = orientFace(img, [0, 0, -1], [1, 0, 0], [0, -1, 0])!;
    expect(texel(flipped, 0, 0)).toEqual([0, 0, 255, 255]);
  });

  it('names the JSON face through the X mirror, and transposes a print turned about its normal', () => {
    expect(orientFace(img, [1, 0, 0], [0, 0, -1], [0, -1, 0])!.face).toBe('west');
    expect(orientFace(img, [-1, 0, 0], [0, 0, 1], [0, -1, 0])!.face).toBe('east');
    expect(orientFace(img, [0, 0, 1], [1, 0, 0], [0, -1, 0])!.face).toBe('south');
    const turned = orientFace(img, [0, 0, -1], [0, -1, 0], [1, 0, 0])!;
    expect([turned.width, turned.height]).toEqual([1, 2]);
  });

  it('refuses a face that looks up or down', () => {
    expect(orientFace(img, [0, 1, 0], [1, 0, 0], [0, 0, 1])).toBeNull();
  });

  it('packs faces without overlap, each keeping a gutter', () => {
    const im = (w: number, h: number) => ({ width: w, height: h, rgba: new Uint8Array(w * h * 4).fill(255) });
    const atlas = packFaceAtlas([im(104, 96), im(104, 96), im(104, 122)]);
    expect(atlas.width % 16).toBe(0);
    const boxes = atlas.at.map(([x, y], k) => ({ x, y, w: [104, 104, 104][k]!, h: [96, 96, 122][k]! }));
    for (const b of boxes) { expect(b.x + b.w).toBeLessThanOrEqual(atlas.width); expect(b.y + b.h).toBeLessThanOrEqual(atlas.height); }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      const apart = a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y;
      expect(apart).toBe(true);
    }
  });
});

// ─── The LXFML side: which printed head a head record is ────────────────────

const PRINTS: LxfPrintTable = validateTable({
  'e:6405179': '3626cp1t.dat',
  'd:1022396': '3626cp1t.dat',
  'e:6416668': '92198p18.dat',
  'n:6454427': '3626pb3484',
  'e:9999999': '92198p18.dat',
  bogus: 12,
}, 'test', validatePrintRow) as LxfPrintTable;
const rec = (designID: string, elementIds: string[], decorationId = ''): LxfPartRecord =>
  ({ designID, materialId: 283, transformation: '1,0,0,0,1,0,0,0,1,0,0,0', boneCount: 1, elementIds, decorationId });
const HEAD_ROW: LxfAlignmentTable = { state: 'ok', source: 't', rejected: 0, entries: { 3626: ['3626c.dat', 0, -0.96, 0, 0, 1, 0, 0] } };
const NO_MEASURED: LxfMeasuredTable = { state: 'ok', source: 'm', entries: {}, rejected: 0 };

describe('printed heads from the LXFML element and decoration ids', () => {
  it('validates rows as file names', () => {
    expect(PRINTS.rejected).toBe(1);
    expect(validatePrintRow('3626cp1t.dat')).toBe(true);
    expect(validatePrintRow('../x.dat')).toBe(false);
  });

  it('reads the decoration id from the brief, else from the part decoration', () => {
    expect(decorationIdOf('1029859;A', '')).toBe('1029859');
    expect(decorationIdOf(null, '1029859_0_VME_11003626_2DP_Back_1;A:VME,1029859_0_VME_Front')).toBe('1029859');
    expect(decorationIdOf('', '')).toBe('');
  });

  it('resolves by element, then decoration, then identity, and never across figure systems', () => {
    expect(printedHeadFor(rec('3626', ['6405179'], '1022396'), PRINTS)).toEqual({ file: '3626cp1t.dat', kind: 'print' });
    expect(printedHeadFor(rec('3626', ['0000000'], '1022396'), PRINTS)).toEqual({ file: '3626cp1t.dat', kind: 'print' });
    expect(printedHeadFor(rec('3626', ['6454427'], '1029859'), PRINTS)).toEqual({ kind: 'identity', printId: '3626pb3484' });
    expect(printedHeadFor(rec('28650', ['6416668'], '1023541'), PRINTS)).toEqual({ file: '92198p18.dat', kind: 'print' });
    // A doll print on a minifig head is refused.
    expect(printedHeadFor(rec('3626', ['9999999'], '1'), PRINTS)).toBeNull();
    expect(printedHeadFor(rec('3001', ['6405179'], '1022396'), PRINTS)).toBeNull();
    expect(HEAD_DESIGNS['28650']).toBe('minidoll');
  });

  it('swaps only the FILE: the head keeps the plain mould\'s placement, and says what it could not resolve', () => {
    const recs = [rec('3626', ['6405179'], '1022396'), rec('3626', ['6454427'], '1029859'), rec('3626', ['1234567'], '42'), rec('3626', ['6405179'])];
    const plain = buildLxfPlacements(recs, HEAD_ROW, NO_MEASURED).bricks;
    const { bricks, diagnostics: d } = buildLxfPlacements(recs, HEAD_ROW, NO_MEASURED, { printMap: PRINTS });
    // The identity head stays the PLAIN mould; its print id rides beside it.
    expect(bricks.map(b => b.part)).toEqual(['3626cp1t.dat', '3626c.dat', '3626c.dat', '3626c.dat']);
    expect(bricks.map(b => b.headPrint)).toEqual([undefined, '3626pb3484', undefined, undefined]);
    bricks.forEach((b, i) => { expect([b.x, b.y, b.z]).toEqual([plain[i]!.x, plain[i]!.y, plain[i]!.z]); });
    expect(d.printedHeads).toBe(1);
    expect(d.unresolvedHeadPrints).toBe(2); // the identity-only head and the unknown one; an UNdecorated head is plain, not unresolved
    expect(describeLxfDiagnostics(d)).toMatch(/2 decorated heads have no printed LDraw part and draw plain \(1 drawn with their own print\)/);
    expect(plain.every(b => b.part === '3626c.dat')).toBe(true);
  });
});
