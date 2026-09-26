/**
 * Mini-doll faces and whole bodies (2026-09-26): the man's joints, the
 * thin-hinge legs, a doll that lost its head or an arm, grouping a doll's wig
 * and its seated legs, and the doll face - the default one, art mapped over
 * the doll head's whole front, and decals that follow the head's curve.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  MINIDOLL_BONES, MINIDOLL_CANON, MINIDOLL_MAN_CANON, assembleMinifig, minidollBones, minidollCanon,
} from '../web/src/engine/minifig-rig.js';
import { compileLdrawEntityGeometry, groupFigures, isFigurePart } from '../web/src/engine/ldraw-entity-compiler.js';
import {
  MINIDOLL_DEFAULT_FACE, clearFaceArt, defaultDollFace, faceArtImage, faceArtRect, headBodyRect, isDollHead, seedFaceArt,
} from '../web/src/engine/head-face.js';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';

const box6 = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color = 16): string[] => {
  const q = (a: number[], b: number[], c: number[], d: number[]): string => `4 ${color} ${[...a, ...b, ...c, ...d].join(' ')}`;
  return [
    q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]), q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]), q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
  ];
};
type Bx = [number, number, number, number, number, number];
const part = (description: string, ...boxes: Bx[]): string => [`0 ${description}`, ...boxes.flatMap(b => box6(...b))].join('\n');
/**
 * The doll head is ROUND at the front: a 10 LDU wide middle column stands 4
 * LDU proud of the cheeks (the real 92198's front falls back ~6 LDU from nose
 * to cheek), so a decal that follows the head sits at two depths.
 */
const DOLL_HEAD: Bx[] = [[-13, 13, 0, 26.5, -12, 10.2], [-5, 5, 0, 26.5, -16, -12]];
const LIBRARY: Record<string, string> = {
  '1006030': part('Figure Friends Girl Torso Dual Mould without Pattern', [-11, 11, -19.3, 17, -8.9, 6.4]),
  '92241': part('Figure Friends Girl Torso without Pattern', [-11, 11, -19.3, 17, -8.9, 6.4]),
  '92242': part('Figure Friends Man Torso', [-12.5, 12.5, -19.8, 16.5, -10, 7.1]),
  '92198': part('Figure Friends Head without Pattern', ...DOLL_HEAD),
  '92240': part('Figure Friends Male Head without Pattern', [-13, 13, 0, 28, -12, 10.2], [-5, 5, 0, 28, -16.2, -12]),
  '92244': part('Figure Friends Female Left Arm', [-10, 21, -4, 32.1, -4, 7.3]),
  '92245': part('Figure Friends Female Right Arm', [-21, 10, -4, 32.1, -4, 7.3]),
  '92246': part('Figure Friends Male Left Arm', [-10, 22, -4, 32.1, -4, 7.3]),
  '92247': part('Figure Friends Male Right Arm', [-22, 10, -4, 32.1, -4, 7.3]),
  '92248': part('Figure Friends Hips', [-10.4, 10.5, -20.4, 9.7, -7.6, 8.6]),
  '1015152': part('Figure Friends Hips with Thin Hinge', [-10.7, 10.7, -20.4, 9.3, -8.1, 8.6]),
  '92251': part('Figure Friends Legs with Cropped Trousers', [-18.8, 18.8, -54.8, 0, -9.7, 13.7]),
  '92253': part('Figure Friends Legs with Trousers', [-18.9, 18.9, -55.5, 0, -9.7, 13.9]),
  '64807': part('MINI WIG NO. 3 (Needs Work)', [-17.4, 18, -7.3, 23.3, -14.2, 21.2]),
  '3001': part('Brick  2 x  4', [-40, 40, -24, 0, -20, 20]),
};
const provider = () => createPartGeometryProvider({ fetchPartText: async id => LIBRARY[id.replace(/^.*\//, '').replace(/\.dat$/i, '')] ?? null });
const meshesFor = async (bricks: ParsedBrick[]): Promise<Map<string, LdrawPartMesh | null>> => {
  const p = provider();
  const m = new Map<string, LdrawPartMesh | null>();
  for (const id of new Set(bricks.map(b => b.part))) m.set(id, await p.getPartMesh(id));
  return m;
};
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const at = (partId: string, color: number, x: number, y: number, z: number, rot = I): ParsedBrick => ({ part: partId, color, x, y, z, rot });
const bySlot = (a: ReturnType<typeof assembleMinifig>, slot: string) => a.bricks.filter((_, i) => a.slots[i] === slot);
const pos = (b: ParsedBrick): number[] => [b.x, b.y, b.z];

afterEach(() => clearFaceArt());

describe('mini-doll bodies: the joints the library measures', () => {
  it('puts a man doll\'s head, arms, hips and legs where LDraw\'s 92240c01 template does', async () => {
    const man = [
      at('92242', 15, 0, -75.3, 0), at('92246', 92, 12.5, -75.3, 0), at('92247', 92, -12.5, -75.3, 0),
      at('92240', 92, 0, -111.5, 0), at('92248', 1, 0, -47.4, 1.2), at('92253', 1, 0, 0, 3.9),
    ];
    const a = assembleMinifig(man, await meshesFor(man));
    expect(a.synthesized).toEqual([]);
    expect(pos(bySlot(a, 'head')[0]!)).toEqual([0, -36.2, 0]);
    expect(pos(bySlot(a, 'arm_left')[0]!)).toEqual([12.5, 0, 0]);
    expect(pos(bySlot(a, 'arm_right')[0]!)).toEqual([-12.5, 0, 0]);
    expect(pos(bySlot(a, 'hips')[0]!)).toEqual([0, 27.9, -1.2]);
    expect(pos(bySlot(a, 'legs')[0]!)).toEqual([0, 75.3, -3.9]);
    // The skeleton follows: the head turns at the man's NECK (his torso's top, not the crown the
    // head mould's origin is at), the arms swing at his shoulders.
    expect(a.rig.bones.find(b => b.name === 'head')!.pivotLdu).toEqual([0, -19.8, 0]);
    expect(a.rig.bones.find(b => b.name === 'arm_left')!.pivotLdu).toEqual([12.5, 0, 0]);
    expect(a.rig.bones.find(b => b.name === 'legs')!.pivotLdu).toEqual([0, 27.9, -1.2]);
  });

  it('chooses the canon by torso and hinge, and keeps the woman\'s skeleton equal to MINIDOLL_BONES', () => {
    expect(minidollCanon('Figure Friends Man Torso Dual Mould')).toBe(MINIDOLL_MAN_CANON);
    expect(minidollCanon('Figure Friends Girl Torso Dual Mould without Pattern')).toBe(MINIDOLL_CANON);
    expect(minidollCanon('Figure Friends Woman Torso Dual Mould', 'Figure Friends Hips with Thin Hinge').legs!.position).toEqual([0, 75.8, -3.9]);
    expect(minidollBones(MINIDOLL_CANON)).toEqual([...MINIDOLL_BONES]);
  });

  it('gives a doll whose source lost its head the plain doll head in its arms\' skin, and a man the man\'s', async () => {
    const headless = [at('1006030', 15, 0, -76.8, 0), at('92244', 86, 11, -76.8, 0), at('92245', 86, -11, -76.8, 0), at('92248', 1, 0, -47.4, 1.2), at('92251', 1, 0, 0, 3.9)];
    const a = assembleMinifig(headless, await meshesFor(headless));
    expect(a.synthesized).toEqual(['head']);
    expect(bySlot(a, 'head')[0]).toMatchObject({ part: '92198', color: 86 });
    expect(pos(bySlot(a, 'head')[0]!)).toEqual([0, -33.2, 0]);
    // A torso-coloured sleeve (not a skin tone) gives the default light nougat.
    const sleeved = headless.map(b => (b.part === '92244' || b.part === '92245' ? { ...b, color: 5 } : b));
    expect(bySlot(assembleMinifig(sleeved, await meshesFor(sleeved)), 'head')[0]!.color).toBe(78);
    const man = [at('92242', 15, 0, -75.3, 0), at('92246', 92, 12.5, -75.3, 0), at('92248', 1, 0, -47.4, 1.2), at('92253', 1, 0, 0, 3.9)];
    const m = assembleMinifig(man, await meshesFor(man));
    expect(m.synthesized).toEqual(['head', 'right arm']);
    expect(bySlot(m, 'head')[0]).toMatchObject({ part: '92240', color: 92 });
    expect(bySlot(m, 'arm_right')[0]).toMatchObject({ part: '92247', color: 92 });
    expect(pos(bySlot(m, 'arm_right')[0]!)).toEqual([-12.5, 0, 0]);
  });
});

describe('mini-doll bodies: grouping', () => {
  it('groups a BrickLink `MINI WIG` sitting 4.4 LDU off its doll\'s head (42639: two dolls walked bald)', async () => {
    const doll = [
      at('1006030', 78, 0, -76.8, 0), at('92244', 78, 11, -76.8, 0), at('92245', 78, -11, -76.8, 0),
      at('92198', 78, 0, -110, 0), at('92248', 1, 0, -47.4, 1.2), at('92251', 1, 0, 0, 3.9),
      at('64807', 0, 0, -106.8, -3), // the wig, 3.2 below and 3 behind the head's origin
    ];
    const m = await meshesFor(doll);
    expect(isFigurePart('64807', m.get('64807')!.description)).toBe(true);
    const groups = groupFigures(doll, m);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.parts).toContain(6);
  });

  it('keeps a SEATED doll\'s legs, whose soles swing 48 LDU in front of her torso', async () => {
    // Legs turned 90 degrees forward at the hips: the origin (the sole) moves forward at hip height.
    const legsForward = [1, 0, 0, 0, 0, 1, 0, -1, 0];
    const seated = [
      at('1006030', 78, 0, -76.8, 0), at('92244', 78, 11, -76.8, 0), at('92245', 78, -11, -76.8, 0),
      at('92198', 78, 0, -110, 0), at('92248', 1, 0, -47.4, 1.2), at('92253', 1, 0, -48.8, -48, legsForward),
    ];
    const groups = groupFigures(seated, await meshesFor(seated));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.parts).toContain(5);
    const a = assembleMinifig(groups[0]!.parts.map(i => seated[i]!), await meshesFor(seated));
    expect(a.synthesized).toEqual([]);
    expect(bySlot(a, 'legs')[0]!.part).toBe('92253');
  });
});

describe('mini-doll faces', () => {
  it('maps doll face art over the head\'s whole FRONT - a minifig head keeps its body rectangle', async () => {
    const m = (await meshesFor([at('92198', 78, 0, 0, 0)])).get('92198')!;
    expect(isDollHead('92198', m)).toBe(true);
    expect(faceArtRect('92198', m)).toEqual({ x0: -13, x1: 13, y0: 0, y1: 26.5 });
    // The 80 %-width body rectangle would stop above a real doll's mouth; the whole front does not.
    expect(headBodyRect(m).y1).toBeLessThanOrEqual(26.5);
    seedFaceArt([['92198pr0147', { width: 2, height: 2, rgba: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 200, 0, 0, 255]) }]]);
    const img = faceArtImage('92198', m, '92198pr0147')!;
    expect(img.rect).toEqual({ x0: -13, x1: 13, y0: 0, y1: 26.5 });
    expect([img.width, img.height]).toEqual([104, 106]);
  });

  it('draws the default doll face where the library\'s 38 doll prints put their features', async () => {
    const m = (await meshesFor([at('92198', 78, 0, 0, 0)])).get('92198')!;
    const f = defaultDollFace('92198', m);
    expect([f.width, f.height]).toEqual([104, 106]);
    const ink = (x: number, y: number): boolean => f.rgba[(Math.round(y) * f.width + Math.round(x)) * 4 + 3]! === 255;
    const D = MINIDOLL_DEFAULT_FACE;
    // Both pupils, on the measured eye line, either side of the centre.
    for (const side of [-1, 1]) expect(ink(f.width * (0.5 + side * D.eyeDx), f.height * D.eyeY + f.height * D.scleraRy * 0.15)).toBe(true);
    // The mouth on its line, and bare skin between the eyes and over the forehead's top.
    expect(ink(f.width / 2, f.height * D.mouthY + f.height * 0.03)).toBe(true);
    expect(ink(f.width / 2, f.height * D.eyeY)).toBe(false);
    expect(ink(f.width / 2, 2)).toBe(false);
  });

  it('gives a plain doll head the default face as TILES that follow its round front', async () => {
    const doll = [
      at('1006030', 78, 0, 0, 0), at('92244', 78, 11, 0, 0), at('92245', 78, -11, 0, 0),
      at('92198', 78, 0, -33.2, 0), at('92248', 1, 0, 29.4, -1.2), at('92251', 1, 0, 76.8, -3.9),
    ];
    const a = assembleMinifig(doll, await meshesFor(doll));
    const r = await compileLdrawEntityGeometry('doll', 'figure', a.bricks, { partGeometry: provider(), rig: a.rig, quality: { studFacets: 1 } });
    expect(r.diagnostics.faceTextures).toMatchObject({ printed: 0, art: 0, default: 1 });
    expect(r.diagnostics.defaultFaces).toBe(0);
    const face = r.meshes.findIndex(x => x.faceAtlas);
    type Cube = { origin: number[]; size: number[]; uv: Record<string, unknown> };
    const cubes = (r.value as { 'minecraft:geometry': Array<{ bones: Array<{ cubes?: Cube[] }> }> })['minecraft:geometry'][face]!.bones.flatMap(b => b.cubes ?? []);
    expect(cubes.length).toBeGreaterThan(2);
    for (const c of cubes) expect(Object.keys(c.uv)).toEqual(['north']);
    // Two depths: the tiles over the nose column stand 4 LDU (0.075 block, 1.2 geometry units) in front of those over the cheeks.
    const fronts = [...new Set(cubes.map(c => Math.round(c.origin[2]! * 1000) / 1000))].sort((x, y) => x - y);
    expect(fronts).toHaveLength(2);
    expect(fronts[1]! - fronts[0]!).toBeCloseTo(4 / 96 * 1.8 * 16, 2);
  });
});
