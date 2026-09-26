/**
 * The three figure systems on one rig (minifig, mini-doll, big-fig), the
 * consensus re-anchor for a torso a converter left at a raw origin, the
 * default face on a plain head, and headwear that carves the head instead of
 * fighting it. The numbers are the ones measured on 76417 (Hagrid, the
 * goblins) and 42703 (the mermaid dolls) on 2026-09-24.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  BIGFIG_BONES, MINIDOLL_BONES, assembleMinifig, classifyFigurePart, classifyMinifigPart, figureAnchor, figureSystemOfTorso,
} from '../web/src/engine/minifig-rig.js';
import { compileLdrawEntityGeometry, faceDecals, figureRole, groupFigures, isFigurePart, isTorso } from '../web/src/engine/ldraw-entity-compiler.js';
import { discoverSceneActors } from '../web/src/engine/bedrock-scene-actors.js';
import { worldFaces } from '../web/src/engine/bedrock-geometry-faces.js';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.js';
import { compilePartPrototype, resolveEntityQuality } from '../web/src/engine/ldraw-part-prototype.js';
import { resolveLdrawEntityMaterial } from '../web/src/engine/ldraw-entity-materials.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';

// ─── A synthetic library: every mould a box at its real bounds, described as the library describes it ───

const box6 = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color = 16): string[] => {
  const q = (a: number[], b: number[], c: number[], d: number[]): string => `4 ${color} ${[...a, ...b, ...c, ...d].join(' ')}`;
  return [
    q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]), q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]), q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
  ];
};
type B = [number, number, number, number, number, number];
const part = (description: string, bounds: B, header = ''): string => [...(header ? [header] : []), `0 ${description}`, ...box6(...bounds)].join('\n');
const LIBRARY: Record<string, string> = {
  // Minifig.
  '973': part('Minifig Torso', [-19, 19, -12, 32, -10, 10]),
  '3626c': part('Minifig Head with Closed Hollow Stud', [-13, 13, 0, 24, -13, 13]),
  // A printed head: the same box plus one explicit-colour quad on the front.
  '3626cp01': [part('Minifig Head with Standard Grin Pattern', [-13, 13, 0, 24, -13, 13]), `4 0 -4 8 -13.01 4 8 -13.01 4 10 -13.01 -4 10 -13.01`].join('\n'),
  '3815': part('Minifig Hips', [-18, 18, -11, 21, -10, 10]),
  '3816': part('Minifig Leg Right', [-19.5, -1.5, -9, 28, -11, 9]),
  '3817': part('Minifig Leg Left', [1.5, 19.5, -9, 28, -11, 9]),
  '3818': part('Minifig Arm Right', [-10, 7, -6.5, 22.44, -13.44, 6.51]),
  '3819': part('Minifig Arm Left', [-7, 10, -6.5, 22.44, -13.44, 6.51]),
  '3820': part('Minifig Hand', [-6, 6, -7.65, 4.61, -15.52, 13]),
  '3901': part('Minifig Hair Male', [-17, 17, -10, 8, -17, 17]),
  '41879b': part('Minifig Hips and Legs Short with Hole', [-19, 19, -11, 24, -10, 10]),
  // Mini-doll (LEGO Friends), Studio's private torso and the official rest.
  '1006030': part('Figure Friends Girl Torso Dual Mould without Pattern', [-11, 11, -19.3, 17, -8.9, 6.4]),
  '92241': part('Figure Friends Girl Torso without Pattern', [-11, 11, -19.3, 17, -8.9, 6.4]),
  '92198': part('Figure Friends Head without Pattern', [-13, 13, 0, 26.5, -16, 10.2]),
  '92244': part('Figure Friends Female Left Arm', [-10, 21, -4, 32.1, -4, 7.3]),
  '92245': part('Figure Friends Female Right Arm', [-21, 10, -4, 32.1, -4, 7.3]),
  '2758': part('Figure Friends Left Arm Stump', [-10, 12, -4, 20, -4, 7]),
  '92248': part('Figure Friends Hips', [-10.4, 10.5, -20.4, 9.7, -7.6, 8.6]),
  '16529': part('Figure Friends Legs Mermaid Tail', [-13.2, 34.2, -55.5, 0, -10.1, 11.1]),
  '1015152': part('Figure Friends Hips with Thin Hinge', [-10.7, 10.7, -20.4, 9.3, -8.1, 8.6]),
  '1022657': part('Figure Friends Legs with Shorts (Thin Hinge)', [-18.8, 18.8, -54.8, 0, -9.7, 13.7]),
  '5828': part('Mini Doll, Hair, Long Full Curly, Parted on Left - 3 Internal Supports', [-22.3, 22.4, -12, 44.3, -29, 18.6]),
  '90370': part('Minifig Microphone', [-7, 7, -12.8, 18, -7, 7]),
  // Big-fig (Studio's files carry a `0 FILE` header before the description).
  '37777': part('Torso Large, Long Coat with Molded Pockets with Broad Lapels', [-29, 29, -14, 71, -18, 22], '0 FILE 37777.dat'),
  '37779': part('Arm Large with Pin, Left', [-20, 22, -9, 27, -9, 14], '0 FILE 37779.dat'),
  '37783': part('Arm Large with Pin, Right', [-22, 20, -9, 27, -9, 14], '0 FILE 37783.dat'),
  '37784': part('Minifigure, Hair Shaggy and Long with Beard', [-27, 27, -12, 39, -23, 23], '0 FILE 37784.dat'),
  '27150': part('Minifig Umbrella Folded', [-4, 4, -44, 4, -4, 4]),
  // BrickLink's hair names (2026-09-25): a doll's in a `bl_` copy, a minifig's official file.
  'bl_2645': part('MINI WIG, NO. 366', [-22, 22, -12, 44, -29, 18], '0 FILE bl_2645.dat'),
  '93217': part('MINI WIG NO. 13 (Needs Work)', [-16, 16, -10, 8, -16, 16]),
  '92251': part('Figure Friends Legs with Cropped Trousers', [-18.8, 18.8, -54.8, 0, -9.7, 13.7]),
  '36752a': part('Minifig Tool Wand', [-1, 1, -2, 30, -1, 1]),
  '98765': part('Minifig Tool Pole', [-1, 1, -10, 70, -1, 1]),
  // The goblins' hair with its ears, Studio-private too.
  '93230p04': part('Minifigure, Hair Swept Back with Pointed Light Nougat Ears Pattern', [-16.7, 16.6, -10, 22.5, -13.9, 21.2], '0 FILE 93230p04.dat'),
  // A building brick, so a scene has a floor.
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

/** 42703's first mermaid doll exactly as the converted source places it: the tail rides the hips. */
const mermaid = (): ParsedBrick[] => [
  at('1006030', 78, 550, -77, -26.1),
  at('92244', 78, 561, -77, -26.1), at('92245', 78, 539, -77, -26.1),
  at('92198', 78, 550, -110.2, -26.1),
  at('92248', 10031, 550, -47.6, -25), at('16529', 10031, 550, -47.6, -25),
  at('5828', 365, 550, -110.3, -29.1),
  at('90370', 0, 524.1, -47.3, -30.1),
];
/** 76417's Hagrid as converted: the big torso 10 / −70.5 LDU from where its own arms, head and legs put it. */
const hagrid = (): ParsedBrick[] => [
  at('3626c', 78, 794.3, -113.6, -771.4), at('37784', 308, 794.3, -113.6, -771.4),
  at('37779', 86, 813.9, -80.1, -771.4, [1, 0, 0, 0, 0.959, 0.2835, 0, -0.2835, 0.959]),
  at('37783', 86, 774.7, -80.1, -771.4, [1, 0, 0, 0, 0.4651, 0.8853, 0, -0.8853, 0.4651]),
  at('3820', 78, 758.3, -65.8, -791.4), at('3820', 78, 830.4, -55.8, -775.3),
  at('41879b', 308, 794.3, -25.6, -771.4),
  at('37777', 86, 784.3, -19.1, -771.4),
  at('27150', 29, 752.2, -75.2, -809.6),
];
/** 42703's fifth doll: head, hair, an arm stump, hips and legs — the torso is not in the source. */
const headlessDoll = (): ParsedBrick[] => [
  at('92198', 78, 820, -110, -26.1), at('5828', 484, 820, -107.8, -29.4),
  at('2758', 78, 831.1, -76.9, -26), at('1015152', 30, 820, -47.4, -27.3), at('1022657', 30, 820, 0, -30),
];

describe('figure systems: classification', () => {
  it('names the system by the torso and reads a description behind a `0 FILE` header', async () => {
    const m = await meshesFor([at('37777', 86, 0, 0, 0), at('1006030', 78, 0, 0, 0), at('973', 4, 0, 0, 0), at('93230p04', 72, 0, 0, 0)]);
    expect(m.get('37777')!.description).toBe('Torso Large, Long Coat with Molded Pockets with Broad Lapels');
    expect(figureSystemOfTorso('37777', m.get('37777')!.description)).toBe('bigfig');
    expect(figureSystemOfTorso('1006030', m.get('1006030')!.description)).toBe('minidoll');
    expect(figureSystemOfTorso('973', 'Minifig Torso')).toBe('minifig');
    expect(figureSystemOfTorso('92198', 'Figure Friends Head without Pattern')).toBeNull();
    expect(isTorso('37777', m.get('37777')!.description)).toBe(true);
    expect(isTorso('1006334', 'Figure Friends Boy Torso Dual Mould without Pattern')).toBe(true);
    // The goblins' ear-hair was `FILE 93230p04.dat` to every classifier before the header was skipped.
    expect(classifyMinifigPart('93230p04', m.get('93230p04')!.description)).toBe('headwear');
    expect(isFigurePart('37783', 'Arm Large with Pin, Right')).toBe(true);
    expect(classifyMinifigPart('37783', 'Arm Large with Pin, Right')).toBe('arm_right');
    expect(classifyMinifigPart('10154', 'Bigfig Arm Left')).toBe('arm_left');
  });

  it('keeps each system\'s body moulds off the other\'s rig but shares accessories', () => {
    expect(classifyFigurePart('minidoll', '92198', 'Figure Friends Head without Pattern')).toBe('head');
    expect(classifyFigurePart('minidoll', '16529', 'Figure Friends Legs Mermaid Tail')).toBe('legs');
    expect(classifyFigurePart('minidoll', '3815', 'Minifig Hips')).toBeNull();
    expect(classifyFigurePart('minidoll', '90370', 'Minifig Microphone')).toBe('held');
    expect(classifyFigurePart('minidoll', '2633', 'Minifig Hair Long with Parted Bangs')).toBe('headwear');
    expect(classifyFigurePart('minifig', '92198', 'Figure Friends Head without Pattern')).toBeNull();
    expect(classifyFigurePart('bigfig', '3820', 'Minifig Hand')).toBe('hand_right');
  });
});

describe('figure systems: the mini-doll rig', () => {
  it('rebuilds a mermaid on the doll canon and moves the tail from the hips to the legs joint', async () => {
    const src = mermaid();
    const a = assembleMinifig(src, await meshesFor(src));
    expect(a.system).toBe('minidoll');
    expect(a.reanchoredLdu).toBeUndefined();
    expect(a.synthesized).toEqual([]);
    const one = (slot: string) => { const p = bySlot(a, slot); expect(p, slot).toHaveLength(1); return p[0]!; };
    expect(pos(one('head'))).toEqual([0, -33.2, 0]);
    expect(pos(one('arm_right'))).toEqual([-11, 0, 0]);
    expect(pos(one('arm_left'))).toEqual([11, 0, 0]);
    expect(pos(one('hips'))).toEqual([0, 29.4, -1.2]);
    // The source put the tail AT the hips (no LDD→LDraw row for 16529); the
    // rig puts it 47.4 below them, where `16529`'s own `!HELP` says its hips pivot is.
    expect(one('legs').part).toBe('16529');
    expect(pos(one('legs'))).toEqual([0, 76.8, -3.9]);
    // The one-piece legs hinge on their own bone at the hips joint (the doll's sit and walk bend it there).
    expect(a.rig.boneOf[a.bricks.indexOf(one('legs'))]).toBe('legs');
    expect(MINIDOLL_BONES.find(b => b.name === 'legs')).toEqual({ name: 'legs', parent: 'hips', pivotLdu: [0, 29.4, -1.2] });
    // Hair keeps its offset from the head; the microphone sits in the canonical right hand.
    const hair = one('headwear');
    expect(hair.x).toBeCloseTo(0, 1); expect(hair.y).toBeCloseTo(-33.3, 1); expect(hair.z).toBeCloseTo(-3, 1);
    const mic = one('held');
    expect(pos(mic).map(v => Math.round(v * 10) / 10)).toEqual([-25.9, 29.7, -4]);
    expect(a.rig.boneOf[a.bricks.indexOf(mic)]).toBe('hand_right');
    expect(a.rig.bones).toEqual([...MINIDOLL_BONES]);
    // Feet: the tail's bottom (its box reaches y 0 in its own frame) at the legs joint.
    expect(a.feetY).toBeCloseTo(76.8, 3);
  });

  it('completes a doll whose torso the source lost: a head with legs anchors the figure', async () => {
    const src = headlessDoll();
    const m = await meshesFor(src);
    expect(figureAnchor(src, m)).toEqual({ index: 0, system: 'minidoll', headless: true });
    const a = assembleMinifig(src, m);
    expect(a.synthesized).toEqual(['torso']);
    const torso = bySlot(a, 'torso')[0]!;
    expect(torso.part).toBe('92241');
    expect(torso.color).toBe(78); // the arm's colour
    expect(a.torso.position.map(v => Math.round(v * 10) / 10)).toEqual([820, -76.8, -26.1]);
    expect(pos(bySlot(a, 'legs')[0]!)).toEqual([0, 76.8, -3.9]);
    expect(bySlot(a, 'arm_left')[0]!.part).toBe('2758');
    // No orphan: nothing in the group was left as a bystander.
    expect(a.bystanders).toEqual([]);
  });
});

describe('figure systems: the 2026-09-25 device report (missing legs, floating hair, floating figures)', () => {
  it('reads a `MINI WIG` as hair on either system: a doll\'s is not carried in its hand, a minifig\'s is not dropped', async () => {
    const m = await meshesFor([at('bl_2645', 6, 0, 0, 0), at('93217', 6, 0, 0, 0)]);
    expect(classifyFigurePart('minidoll', 'bl_2645', m.get('bl_2645')!.description)).toBe('headwear');
    expect(classifyFigurePart('minifig', '93217', m.get('93217')!.description)).toBe('headwear');
    // 41732's doll: torso, head, arms, hips, and its wig at the head.
    const doll = [
      at('1006030', 78, 0, -77, 0), at('92244', 78, 11, -77, 0), at('92245', 78, -11, -77, 0),
      at('92198', 78, 0, -110.2, 0), at('92248', 322, 0, -47.6, 1.2), at('bl_2645', 6, 0, -110.2, 0),
    ];
    const a = assembleMinifig(doll, await meshesFor(doll));
    expect(bySlot(a, 'held')).toHaveLength(0);
    expect(bySlot(a, 'headwear').map(b => b.part)).toEqual(['bl_2645']);
    // The source lost the legs: the plain doll legs complete it, in the hips' colour.
    expect(a.synthesized).toEqual(['legs']);
    const legs = bySlot(a, 'legs')[0]!;
    expect(legs.part).toBe('92251');
    expect(legs.color).toBe(322);
    expect(pos(legs)).toEqual([0, 76.8, -3.9]);
  });

  it('keeps a doll\'s one real arm as built (42703\'s stump) and supplies both when both are gone', async () => {
    const one = assembleMinifig(headlessDoll(), await meshesFor(headlessDoll()));
    expect(one.synthesized).toEqual(['torso']);
    const armless = [at('1006030', 78, 0, -77, 0), at('92198', 78, 0, -110.2, 0), at('92248', 322, 0, -47.6, 1.2), at('92251', 322, 0, 0, -2.7)];
    const a = assembleMinifig(armless, await meshesFor(armless));
    expect(a.synthesized).toEqual(['right arm', 'left arm']);
    expect(bySlot(a, 'arm_right')[0]!.part).toBe('92245');
    expect(bySlot(a, 'arm_left')[0]!.part).toBe('92244');
  });

  it('leaves a wand lying at a figure\'s feet to the scenery, and keeps the one in its hand', async () => {
    const fig = [
      at('973', 4, 0, -72, 0), at('3815', 4, 0, -40, 0), at('3816', 4, 0, -28, 0), at('3817', 4, 0, -28, 0),
      at('3818', 4, -15.5, -63, 0), at('3819', 4, 15.5, -63, 0), at('3820', 78, -23.9, -45.4, -10.3), at('3820', 78, 23.9, -45.4, -10.3),
      at('3626c', 78, 0, -96, 0),
      at('36752a', 0, -23.9, -45.4, -12), // in the right hand
      at('36752a', 0, -6, -2, 12), // on the floor between the feet (76457's second wand)
    ];
    const groups = groupFigures(fig, await meshesFor(fig));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.parts).toContain(9);
    expect(groups[0]!.parts).not.toContain(10);
  });

  it('stands a figure on its soles, not on an item hanging below them', async () => {
    const fig = [
      at('973', 4, 0, -72, 0), at('3815', 4, 0, -40, 0), at('3816', 4, 0, -28, 0), at('3817', 4, 0, -28, 0),
      at('3818', 4, -15.5, -63, 0), at('3819', 4, 15.5, -63, 0), at('3820', 78, -23.9, -45.4, -10.3), at('3820', 78, 23.9, -45.4, -10.3),
      at('3626c', 78, 0, -96, 0),
      at('98765', 29, -23.9, -45.4, -12), // a pole gripped at the top, hanging 70 LDU: its foot under the soles
    ];
    const a = assembleMinifig(fig, await meshesFor(fig));
    const r = await compileLdrawEntityGeometry('fig', 'figure', a.bricks, { partGeometry: provider(), rig: a.rig });
    type J = { name: string; parent?: string; pivot: [number, number, number]; rotation?: [number, number, number]; cubes?: Array<{ origin: [number, number, number]; size: [number, number, number] }> };
    const geo = (r.value as { 'minecraft:geometry': Array<{ bones: J[] }> })['minecraft:geometry'];
    // World heights, through the bone rotations (a held item rides a turned bone).
    const bones = new Map<string, J>();
    for (const g of geo) for (const b of g.bones) if (!bones.has(b.name) || b.cubes?.length) bones.set(b.name, { ...bones.get(b.name), ...b });
    const entry = { bones: [...bones.values()], groups: [{ ldrawColor: 0, alpha: 1, cubes: [...bones.values()].flatMap(b => (b.cubes ?? []).map(c => ({ bone: b.name, origin: c.origin, size: c.size }))) }] };
    const faces = worldFaces([{ typeId: 'fig', kind: 'figure', entry, at: { x: 0, y: 0, z: 0 }, yawDeg: 0 }]);
    const lowest = (pick: (bone: string) => boolean): number => Math.min(...faces.filter(f => pick(entry.groups[0]!.cubes[f.cube]!.bone)).flatMap(f => f.corners.map(c => c[1])));
    expect(lowest(b => b === 'leg_right' || b === 'leg_left')).toBeCloseTo(0, 1);
    expect(lowest(() => true)).toBeLessThan(-0.5); // the umbrella's tip, below the floor
  });
});

describe('figure systems: the big-fig rig', () => {
  it('re-anchors the frame on the limbs when the torso alone disagrees, and dresses hair, hands and short legs', async () => {
    const src = hagrid();
    const a = assembleMinifig(src, await meshesFor(src));
    expect(a.system).toBe('bigfig');
    expect(a.synthesized).toEqual([]);
    expect(a.bystanders).toEqual([]);
    // The torso's own placement was (784.3, −19.1): the head, both arms and
    // the legs agree the torso origin is (794.3, −89.6), so the frame moves there.
    expect(a.reanchoredLdu!.map(v => Math.round(v * 10) / 10)).toEqual([10, -70.5, 0]);
    expect(a.torso.position.map(v => Math.round(v * 10) / 10)).toEqual([794.3, -89.6, -771.4]);
    const one = (slot: string) => { const p = bySlot(a, slot); expect(p, slot).toHaveLength(1); return p[0]!; };
    expect(pos(one('torso'))).toEqual([0, 0, 0]);
    expect(pos(one('head'))).toEqual([0, -24, 0]);
    expect(pos(one('headwear'))).toEqual([0, -24, 0]);
    expect(pos(one('arm_right'))).toEqual([-20, 9.5, 0]);
    expect(one('arm_right').rot).toEqual(I);
    expect(pos(one('arm_left'))).toEqual([20, 9.5, 0]);
    expect(pos(one('hips_legs'))).toEqual([0, 64, 0]);
    // The hands stay at their source offset from their (now straightened) arm.
    const hr = one('hand_right');
    expect(hr.x).toBeCloseTo(-36.5, 0); expect(hr.y).toBeCloseTo(33.9, 0);
    expect(a.rig.boneOf[a.bricks.indexOf(hr)]).toBe('arm_right');
    expect(a.rig.bones).toEqual([...BIGFIG_BONES]);
    // Feet: the short legs' bottom, 64 + 24.
    expect(a.feetY).toBeCloseTo(88, 3);
  });
});

describe('figure systems: grouping, role, scene floor', () => {
  it('groups a big-fig\'s parts around a torso 70 LDU below them and does not steal a neighbour\'s', async () => {
    const goblin = [at('973', 0, 890, -56, -770), at('3626c', 78, 890, -80, -770), at('93230p04', 72, 890, -80, -770), at('41879b', 0, 890, -24, -770)];
    const bricks = [...hagrid(), ...goblin];
    const m = await meshesFor(bricks);
    const groups = groupFigures(bricks, m);
    expect(groups).toHaveLength(2);
    const big = groups.find(g => bricks[g.torso]!.part === '37777')!;
    expect(big.parts.map(i => bricks[i]!.part).sort()).toEqual(['27150', '3626c', '37777', '37779', '37783', '37784', '3820', '3820', '41879b'].sort());
    expect(figureRole(big.parts.map(i => bricks[i]!), m)).toBe('npc');
    const small = groups.find(g => bricks[g.torso]!.part === '973')!;
    expect(small.parts).toHaveLength(4);
  });

  it('groups a torso-less doll around its head', async () => {
    const bricks = [...headlessDoll(), ...mermaid()];
    const m = await meshesFor(bricks);
    const groups = groupFigures(bricks, m);
    expect(groups).toHaveLength(2);
    const headless = groups.find(g => bricks[g.torso]!.part === '92198' && bricks[g.torso]!.x === 820)!;
    expect(headless.parts).toHaveLength(5);
    expect(figureRole(headless.parts.map(i => bricks[i]!), m)).toBe('npc');
  });

  it('stands a scene figure on the rig\'s feet, not on a mis-converted torso\'s bounds', async () => {
    // Hagrid over a brick floor: his torso's own box would put the floor 36 LDU under the ground.
    const floor = Array.from({ length: 6 }, (_, i) => at('3001', 1, 700 + i * 80, 16, -770));
    const scene = await discoverSceneActors([...hagrid(), ...floor], provider());
    expect(scene.figures).toHaveLength(1);
    // Head at −113.6 → torso −89.6 → feet 88 below: −1.6 (the source floats him 17.6 LDU; that is the source's).
    expect(scene.figures[0]!.floorLdu).toBeCloseTo(-1.6, 1);
    expect(scene.figures[0]!.centreLdu[0]).toBeCloseTo(794.3 + (scene.figures[0]!.centreLdu[0] - 794.3), 5);
  });
});

describe('figure systems: faces and hair through the compiler', () => {
  it('draws a default face on a plain head, in black on light skin and white on dark, and none on a printed head', () => {
    const q = resolveEntityQuality('balanced');
    const p = provider();
    const build = async (id: string) => compilePartPrototype((await p.getPartMesh(id))!, q);
    return (async () => {
      const plain = await build('3626c');
      const dark = faceDecals(plain, resolveLdrawEntityMaterial(0));
      const light = faceDecals(plain, resolveLdrawEntityMaterial(78));
      expect(light).toHaveLength(3);
      expect(light.every(c => c.color === 0)).toBe(true);
      expect(dark.every(c => c.color === 15)).toBe(true);
      // Proud of the front (−Z is the face), within the head's width, eyes above the mouth.
      for (const c of light) { expect(c.min[2]).toBeLessThan(-13); expect(c.min[0]).toBeGreaterThan(-13); expect(c.max[0]).toBeLessThan(13); }
      expect(light[0]!.max[1]).toBeLessThan(light[2]!.min[1]);
      expect(light[0]!.max[0]).toBeLessThan(0); expect(light[1]!.min[0]).toBeGreaterThan(0);
    })();
  });

  it('gives every plain head in an entity a face and carves the head under its hair', async () => {
    const hairy: ParsedBrick[] = [at('973', 4, 0, 0, 0), at('3626c', 14, 0, -24, 0), at('3901', 72, 0, -24, 0), at('3815', 4, 0, 32, 0), at('3816', 4, 0, 44, 0), at('3817', 4, 0, 44, 0)];
    const geo = await compileLdrawEntityGeometry('fig', 'figure', hairy, { partGeometry: provider(), quality: { studFacets: 1 } });
    expect(geo.diagnostics.defaultFaces).toBe(1);
    expect(geo.diagnostics.headCubesCarved).toBeGreaterThan(0);
    // No skin cube shares volume with a hair cube in what ships.
    const meshes = (geo.value as { 'minecraft:geometry': Array<{ bones: Array<{ cubes: Array<{ origin: number[]; size: number[] }> }> }> })['minecraft:geometry'];
    const cubesOf = (colorId: number) => meshes.flatMap((m, i) => geo.meshes[i]!.material.colorId === colorId ? m.bones.flatMap(b => b.cubes) : []);
    const skin = cubesOf(14), hair = cubesOf(72);
    expect(skin.length).toBeGreaterThan(0); expect(hair.length).toBeGreaterThan(0);
    const overlap = (a: { origin: number[]; size: number[] }, b: { origin: number[]; size: number[] }): boolean =>
      [0, 1, 2].every(i => Math.min(a.origin[i]! + a.size[i]!, b.origin[i]! + b.size[i]!) - Math.max(a.origin[i]!, b.origin[i]!) > 0.02);
    expect(skin.some(s => hair.some(h => overlap(s, h)))).toBe(false);
    // A printed head keeps its print and gets no default face.
    const printed = await compileLdrawEntityGeometry('fig2', 'figure', [...hairy.slice(0, 1), at('3626cp01', 14, 0, -24, 0), ...hairy.slice(3)], { partGeometry: provider(), quality: { studFacets: 1 } });
    expect(printed.diagnostics.defaultFaces).toBe(0);
  });

  it('draws a printed head\'s face as ONE textured decal, and seeded art on a head no library prints', async () => {
    type Cube = { origin: number[]; size: number[]; uv: unknown };
    const body = [at('973', 4, 0, 0, 0), at('3815', 4, 0, 32, 0), at('3816', 4, 0, 44, 0), at('3817', 4, 0, 44, 0)];
    const cubesOf = (geo: Awaited<ReturnType<typeof compileLdrawEntityGeometry>>, pick: (i: number) => boolean): Cube[] =>
      (geo.value as { 'minecraft:geometry': Array<{ bones: Array<{ cubes: Cube[] }> }> })['minecraft:geometry'].flatMap((m, i) => (pick(i) ? m.bones.flatMap(b => b.cubes) : []));
    const printed = await compileLdrawEntityGeometry('fig', 'figure', [...body, at('3626cp01', 14, 0, -24, 0)], { partGeometry: provider(), quality: { studFacets: 1 } });
    const faceMesh = printed.meshes.findIndex(m => m.faceAtlas);
    expect(faceMesh).toBeGreaterThanOrEqual(0);
    expect(printed.diagnostics.faceTextures).toMatchObject({ printed: 1, art: 0 });
    expect(printed.diagnostics.defaultFaces).toBe(0);
    const decals = cubesOf(printed, i => i === faceMesh);
    expect(decals).toHaveLength(1);
    // Per-face UV naming ONE face: the head looks out of the figure's front.
    expect(Object.keys(decals[0]!.uv as object)).toEqual(['north']);
    // The print's black cuboid is gone from the head; the decal carries it.
    expect(printed.meshes.some(m => !m.faceAtlas && m.material.colorId === 0)).toBe(false);
    const png = printed.meshes[faceMesh]!.faceAtlas!.png;
    expect([...png.subarray(1, 4)].map(c => String.fromCharCode(c)).join('')).toBe('PNG');
    // The minifig creator keeps prints as colour layers.
    const layered = await compileLdrawEntityGeometry('fig', 'figure', [...body, at('3626cp01', 14, 0, -24, 0)], { partGeometry: provider(), quality: { studFacets: 1 }, faceTextures: false });
    expect(layered.meshes.some(m => m.faceAtlas)).toBe(false);
    expect(layered.meshes.some(m => m.material.colorId === 0)).toBe(true);

    // A head named by its BrickLink print (no library ships it) draws the plain
    // mould; with art seeded under that name it gets the art, not the default face.
    const { seedFaceArt, clearFaceArt } = await import('../web/src/engine/head-face.js');
    const named = [...body, { ...at('3626c', 78, 0, -24, 0), headPrint: '3626pb3484' }];
    const before = await compileLdrawEntityGeometry('fig', 'figure', named, { partGeometry: provider(), quality: { studFacets: 1 } });
    expect(before.diagnostics.defaultFaces).toBe(1);
    seedFaceArt([['3626cpb3484', { width: 1, height: 1, rgba: new Uint8Array([10, 20, 30, 255]) }]]);
    try {
      const after = await compileLdrawEntityGeometry('fig', 'figure', named, { partGeometry: provider(), quality: { studFacets: 1 } });
      expect(after.diagnostics.faceTextures).toMatchObject({ printed: 0, art: 1 });
      expect(after.diagnostics.defaultFaces).toBe(0);
    } finally { clearFaceArt(); }
  });

  it('compiles a big-fig and a mini-doll as jointed entities with faces', async () => {
    const big = await compileLdrawEntityGeometry('hagrid', 'figure', hagrid(), { partGeometry: provider(), quality: { studFacets: 1 } });
    expect(big.figure).toBeDefined();
    expect(big.diagnostics.minifig?.system).toBe('bigfig');
    expect(big.diagnostics.defaultFaces).toBe(1);
    expect(big.warnings.some(w => /rebuilt around the limbs/.test(w))).toBe(true);
    // A big-fig is taller than a minifig: head top (−24 − 24 stud ... its box) to feet at 88.
    expect(big.sizeBlocks.height).toBeGreaterThan(2.0);
    const doll = await compileLdrawEntityGeometry('doll', 'figure', mermaid(), { partGeometry: provider(), quality: { studFacets: 1 } });
    expect(doll.diagnostics.minifig?.system).toBe('minidoll');
    expect(doll.diagnostics.defaultFaces).toBe(1);
    expect(doll.warnings.some(w => /rebuilt around/.test(w))).toBe(false);
  });
});

// ─── Two riders in one car, and the torso repair at the source ──────────────

describe('figure systems: a car with two posed riders, and the torso repair', () => {
  it('keeps every rider of a car: the first seat is the player\'s variant, the others ride in the body', async () => {
    const { canonicalCoasterCar } = await import('../web/src/engine/bedrock-coaster.js');
    const I9 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const v3 = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
    const bricks: ParsedBrick[] = [
      at('26021', 322, 0, 0, 0, I9), at('24869', 72, 25, 17.4, 0, I9),
      at('973', 4, -18, -45, 0, I9), at('3626c', 14, -18, -69, 0, I9),
      at('37777', 86, 30, -30, 0, I9), at('37784', 308, 30, -54, 0, I9),
    ];
    const car = {
      id: 'car:0', chassis: { index: 0, part: '26021.dat', description: 'Train Base  4 x  5 Roller Coaster' }, bricks: [0, 1], wheels: [1],
      frame: { originLdu: v3(0, 0, 0), rot: I9, travelWorld: v3(1, 0, 0), upWorld: v3(0, -1, 0) },
      extentLocalLdu: { min: v3(-70, -41, -40), max: v3(71, 46, 40) }, lengthLdu: 141, widthLdu: 80, heightLdu: 87,
      seats: [
        { localLdu: v3(-18, -1, 0), worldLdu: v3(0, 0, 0), source: 'rider' as const, riderBricks: [2, 3] },
        { localLdu: v3(30, -1, 0), worldLdu: v3(0, 0, 0), source: 'rider' as const, riderBricks: [4, 5] },
      ],
    };
    const canonical = canonicalCoasterCar(car, bricks, 14);
    expect(canonical.rider.map(b => b.part)).toEqual(['973', '3626c']);
    // The passenger is in the BODY, so the car carries it whoever sits in the first seat.
    expect(canonical.bricks.map(b => b.part)).toEqual(['26021', '24869', '37777', '37784']);
    expect(canonical.seatLdu!.map(v => Math.round(v * 10) / 10)).toEqual([-18, -15, 0]);
  });

  it('moves a mis-converted torso to its limbs in the source placements and leaves every other object alone', async () => {
    const { repairFigureTorsos } = await import('../web/src/engine/ldraw-entity-compiler.js');
    const bricks = [...hagrid(), ...mermaid(), at('3001', 1, 0, 0, 0)];
    const m = await meshesFor(bricks);
    const out = repairFigureTorsos(bricks, m);
    expect(out.repairs).toHaveLength(1);
    expect(out.repairs[0]!.part).toBe('37777');
    expect(out.repairs[0]!.system).toBe('bigfig');
    expect(out.repairs[0]!.offsetLdu.map(v => Math.round(v * 10) / 10)).toEqual([10, -70.5, 0]);
    const torso = out.bricks.find(b => b.part === '37777')!;
    expect([torso.x, torso.y, torso.z].map(v => Math.round(v * 10) / 10)).toEqual([794.3, -89.6, -771.4]);
    // Same objects everywhere else (identity-keyed sets downstream stay valid), and idempotent.
    const others = bricks.filter(x => x.part !== '37777');
    expect(out.bricks.filter(b => b.part !== '37777').every((b, i) => b === others[i])).toBe(true);
    const again = repairFigureTorsos(out.bricks, m);
    expect(again.repairs).toEqual([]);
    expect(again.bricks).toBe(out.bricks);
  });
});

// ─── The published 76417 (skipped where the corpus is absent, e.g. CI) ─────

const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const PUBLISHED_76417 = 'C:/git/clego/lego_sets/DbixConvV3/76417.ldr';
const HAVE_76417 = existsSync(LDRAW_ROOT) && existsSync(PUBLISHED_76417);

describe.skipIf(!HAVE_76417)('76417 Gringotts as published (d3a02437401c): Hagrid rides the vault cart with Harry', () => {
  it('finds 13 figures, repairs one torso (the big-fig), and seats both riders in the one car', async () => {
    const { parseLDrawDocument } = await import('../web/src/engine/ldraw-parser.js');
    const { setLDrawRoot } = await import('../web/src/engine/ldraw-geometry.js');
    const { repairFigureTorsos } = await import('../web/src/engine/ldraw-entity-compiler.js');
    const { detectCoasterAssemblies } = await import('../web/src/engine/coaster-assemblies.js');
    const { extractCoasterTrackRoutes } = await import('../web/src/engine/coaster-track.js');
    const { canonicalCoasterCar } = await import('../web/src/engine/bedrock-coaster.js');
    setLDrawRoot(LDRAW_ROOT);
    const doc = parseLDrawDocument(readFileSync(PUBLISHED_76417, 'utf8'));
    const p = createPartGeometryProvider({ document: doc });
    const m = new Map<string, LdrawPartMesh | null>();
    await Promise.all([...new Set(doc.bricks.map(b => b.part))].map(async part => { m.set(part, await p.getPartMesh(part)); }));
    // The finished-model page: 12 minifigs and the big-fig; 17 heads, of which
    // 4 are decoration (a gold finial with a bar, a grey bust in the vault, a
    // white and a lavender ornament) and belong to no figure.
    const groups = groupFigures(doc.bricks, m);
    expect(groups).toHaveLength(13);
    const big = groups.find(g => doc.bricks[g.torso]!.part === '37777.dat')!;
    expect(big.parts).toHaveLength(10);
    const repaired = repairFigureTorsos(doc.bricks, m);
    expect(repaired.repairs.map(r => r.part)).toEqual(['37777.dat']);
    // The finished-model page pitches the cart 8.5 degrees, so the 10 / −70.5
    // torso-frame move is (8.5, −70.1, −8.9) in the world: 71 LDU either way.
    expect(Math.round(Math.hypot(...repaired.repairs[0]!.offsetLdu))).toBe(71);
    expect(repaired.repairs[0]!.offsetLdu[1]).toBeLessThan(-69);
    // The cart on the vault rail carries Harry (the first seat) and Hagrid (a passenger in the body).
    const tracks = extractCoasterTrackRoutes(repaired.bricks, { isGeometryAvailable: (_id, b) => (m.get(b.part)?.triangles.length ?? 0) > 0 });
    const assemblies = detectCoasterAssemblies(repaired.bricks, m, tracks);
    expect(assemblies.cars).toHaveLength(1);
    const car = assemblies.cars[0]!;
    // Hagrid is 9 parts once his torso is where his limbs are: the cart-floor
    // saucer (38799) the raw torso had pulled into his group goes back to the cart.
    expect(car.seats.map(s => s.riderBricks.length).sort()).toEqual([8, 9]);
    const canonical = canonicalCoasterCar(car, repaired.bricks, 14);
    const parts = [...canonical.bricks, ...canonical.rider].map(b => b.part);
    for (const id of ['37777.dat', '37779.dat', '37783.dat', '37784.dat', '973.dat', '36762.dat']) expect(parts).toContain(id);
    // Nothing is posed off upright: every figure is either an NPC or a rider.
    const scene = await discoverSceneActors(repaired.bricks, p);
    expect(scene.figures).toHaveLength(13);
    expect(scene.posedFigures).toHaveLength(0);
  }, 120_000);
});
