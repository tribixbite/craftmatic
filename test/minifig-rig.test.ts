import { describe, expect, it } from 'vitest';
import {
  MINIFIG_ANIMATIONS, MINIFIG_BONES, MINIFIG_CANON, MINIFIG_CLIENT_ANIMATIONS, MINIFIG_FEET_Y,
  assembleMinifig, classifyMinifigPart, minifigFromSpec,
} from '../web/src/engine/minifig-rig.js';
import { compileLdrawEntityGeometry, ldrawToRenderRotation } from '../web/src/engine/ldraw-entity-compiler.js';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';

// ─── A synthetic minifig library: every mould a box at the real bounds ───────

const box6 = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): string[] => {
  const q = (a: number[], b: number[], c: number[], d: number[]): string => `4 16 ${[...a, ...b, ...c, ...d].join(' ')}`;
  return [
    q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]), q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]), q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
  ];
};
const part = (description: string, bounds: [number, number, number, number, number, number]): string => [`0 ${description}`, ...box6(...bounds)].join('\n');
const LIBRARY: Record<string, string> = {
  '973': part('Minifig Torso', [-19, 19, -12, 32, -10, 10]),
  '973pb9': part('Minifig Torso with Print', [-19, 19, -12, 32, -10, 10]),
  '3626c': part('Minifig Head with Closed Hollow Stud', [-13, 13, 0, 24, -13, 13]),
  '3815': part('Minifig Hips', [-18, 18, -11, 21, -10, 10]),
  '3816': part('Minifig Leg Right', [-19.5, -1.5, -9, 28, -11, 9]),
  '3817': part('Minifig Leg Left', [1.5, 19.5, -9, 28, -11, 9]),
  '3818': part('Minifig Arm Right', [-10, 7, -6.5, 22.44, -13.44, 6.51]),
  '3819': part('Minifig Arm Left', [-7, 10, -6.5, 22.44, -13.44, 6.51]),
  '3820': part('Minifig Hand', [-6, 6, -7.65, 4.61, -15.52, 13]),
  '3901': part('Minifig Hair Male', [-17, 17, -10, 8, -17, 17]),
  '3836': part('Minifig Pushbroom', [-17, 17, 0, 84, -6, 10]),
  '970c00': part('Minifig Hips and Legs', [-19.5, 19.5, -11, 40, -11, 10]),
  '4524': part('Minifig Cape', [-20, 20, 0, 40, 8, 12]),
};
const provider = () => createPartGeometryProvider({ fetchPartText: async id => LIBRARY[id.replace(/^.*\//, '')] ?? null });
const meshesFor = async (bricks: ParsedBrick[]): Promise<Map<string, LdrawPartMesh | null>> => {
  const p = provider();
  const m = new Map<string, LdrawPartMesh | null>();
  for (const id of new Set(bricks.map(b => b.part))) m.set(id, await p.getPartMesh(id));
  return m;
};
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const at = (partId: string, color: number, x: number, y: number, z: number, rot = I): ParsedBrick => ({ part: partId, color, x, y, z, rot });
const bySlot = (a: ReturnType<typeof assembleMinifig>, slot: string) => a.bricks.filter((_, i) => a.slots[i] === slot);

describe('classifyMinifigPart', () => {
  it('reads the library description first and the id family second', () => {
    expect(classifyMinifigPart('973pb5459', 'Minifig Torso')).toBe('torso');
    expect(classifyMinifigPart('bl_973pb5574c01_torso', '')).toBe('torso');
    expect(classifyMinifigPart('3816', 'Minifig Leg Right')).toBe('leg_right');
    expect(classifyMinifigPart('3817', '')).toBe('leg_left');
    expect(classifyMinifigPart('970c00', '~Moved to 3815c01')).toBe('hips_legs');
    expect(classifyMinifigPart('3815b', 'Minifig Hips')).toBe('hips');
    expect(classifyMinifigPart('983', '~Moved to 3820')).toBe('hand_right');
    expect(classifyMinifigPart('3626cpb1571', 'Minifig Head with Closed Hollow Stud')).toBe('head');
    expect(classifyMinifigPart('11256', 'Minifig Hair Short, Wavy with Side Part')).toBe('headwear');
    expect(classifyMinifigPart('27059', '=Minifig Hat Beanie')).toBe('headwear');
    expect(classifyMinifigPart('4524', 'Minifig Cape')).toBe('back');
    expect(classifyMinifigPart('2524', 'Minifig Backpack Non-Opening')).toBe('back');
    expect(classifyMinifigPart('3836', 'Minifig Pushbroom')).toBe('held');
    expect(classifyMinifigPart('3846', 'Minifig Shield Triangular')).toBe('held');
  });
});

describe('assembleMinifig', () => {
  it('re-places a complete figure at the canonical offsets whatever the source pose', async () => {
    // A rebel pilot posed in a cockpit: torso turned 45° about Y and every limb bent.
    const R45 = [Math.SQRT1_2, 0, -Math.SQRT1_2, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2];
    const src: ParsedBrick[] = [
      at('973pb9', 25, 140, -8, -100, R45),
      at('3626c', 14, 140, -32, -100, R45),
      at('3815', 8, 140, 24, -100, R45),
      at('3816', 25, 140, 36, -100, [1, 0, 0, 0, 0, 1, 0, -1, 0]),
      at('3817', 25, 140, 36, -100, [1, 0, 0, 0, 0, 1, 0, -1, 0]),
      at('3818', 25, 129, 1, -111, [0.9, -0.3, 0.3, 0.3, 0.9, 0, -0.3, 0, 0.9]),
      at('3819', 25, 151, 1, -89, [0.9, 0.3, 0.3, -0.3, 0.9, 0, -0.3, 0, 0.9]),
      at('3820', 0, 123, 19, -117), at('3820', 0, 157, 19, -83),
    ];
    const a = assembleMinifig(src, await meshesFor(src));
    expect(a.synthesized).toEqual([]);
    expect(a.dropped).toEqual([]);
    const one = (slot: string) => { const p = bySlot(a, slot); expect(p).toHaveLength(1); return p[0]!; };
    expect([one('torso').x, one('torso').y, one('torso').z]).toEqual([0, 0, 0]);
    expect([one('head').x, one('head').y, one('head').z]).toEqual([0, -24, 0]);
    expect([one('hips').x, one('hips').y, one('hips').z]).toEqual([0, 32, 0]);
    expect([one('leg_right').x, one('leg_right').y, one('leg_right').z]).toEqual([0, 44, 0]);
    expect(one('leg_right').rot).toEqual(I);
    expect(one('arm_right').x).toBeCloseTo(-15.552, 3);
    expect(one('arm_left').x).toBeCloseTo(15.552, 3);
    expect(one('hand_right').x).toBeCloseTo(-23.86, 2);
    expect(one('hand_left').x).toBeCloseTo(23.86, 2);
    // The hand's rotation is the arm's 10° turn then the 45° wrist tilt (OMR 7140, measured).
    const expectedHand = [0.985, -0.123, 0.123, 0.174, 0.696, -0.696, 0, 0.707, 0.707];
    one('hand_right').rot!.forEach((v, i) => expect(v).toBeCloseTo(expectedHand[i]!, 2));
    // Facing: the torso's −Z through R45, horizontal.
    expect(a.facingLdu[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(a.facingLdu[1]).toBeCloseTo(-Math.SQRT1_2, 5);
    // Every placement is on a rig bone.
    expect(new Set(a.rig.boneOf)).toEqual(new Set(['body', 'head', 'hips', 'leg_right', 'leg_left', 'arm_right', 'arm_left', 'hand_right', 'hand_left']));
  });

  it('synthesises the arms, legs and head a converted source lost, in the colours the figure gives away', async () => {
    // The IOModel2V2 museum: torso, hair and two hands - no arms, no legs, no head.
    const src: ParsedBrick[] = [
      at('973pb9', 71, 620, -164, -340),
      at('3901', 71, 620, -160, -336),
      at('3820', 14, 596, -135, -337), at('3820', 14, 641, -150, -360),
    ];
    const a = assembleMinifig(src, await meshesFor(src));
    expect(a.synthesized.sort()).toEqual(['head', 'hips', 'left arm', 'left leg', 'right arm', 'right leg'].sort());
    expect(bySlot(a, 'head')[0]).toMatchObject({ part: '3626c', color: 14 }); // skin from the hands
    expect(bySlot(a, 'arm_right')[0]).toMatchObject({ part: '3818', color: 71 }); // arms match the torso
    expect(bySlot(a, 'leg_left')[0]).toMatchObject({ part: '3817', color: 71 });
    expect(bySlot(a, 'hand_left')[0]).toMatchObject({ part: '3820', color: 14 });
    // The found hands are canonical too (the source's were posed).
    expect(bySlot(a, 'hand_right')[0]!.x).toBeCloseTo(-23.86, 2);
    // Hair keeps its source offset from the torso (the head is synthesised at the canonical spot, so torso-relative is what the source says).
    const hair = bySlot(a, 'headwear')[0]!;
    expect([hair.x, hair.y, hair.z]).toEqual([0, 4, 4]);
    expect(a.rig.boneOf[a.bricks.indexOf(hair)]).toBe('head');
  });

  it('splits a hips-and-legs composite into three moulds so the legs can move', async () => {
    const src: ParsedBrick[] = [at('973', 71, 0, 0, 0), at('3626c', 14, 0, -24, 0), at('970c00', 1, 0, 32, 0)];
    const a = assembleMinifig(src, await meshesFor(src));
    expect(bySlot(a, 'hips')[0]).toMatchObject({ part: '3815', color: 1 });
    expect(bySlot(a, 'leg_right')[0]).toMatchObject({ part: '3816', color: 1, y: 44 });
    expect(bySlot(a, 'leg_left')[0]).toMatchObject({ part: '3817', color: 1, y: 44 });
    expect(a.synthesized).not.toContain('hips');
    expect(a.bricks.some(b => b.part === '970c00')).toBe(false);
  });

  it('puts a held item in the nearest hand, re-expressed in the canonical hand frame', async () => {
    // A pushbroom 10 LDU "up" the posed right hand's own frame: it lands 10 LDU up the canonical hand.
    // The posed hand is turned exactly 90° about X (an orthogonal matrix, so its transpose is its inverse).
    const handRot = [1, 0, 0, 0, 0, -1, 0, 1, 0];
    const hand = at('3820', 14, -30, 20, -40, handRot);
    const item = at('3836', 70, -30 + handRot[1]! * -10, 20 + handRot[4]! * -10, -40 + handRot[7]! * -10, handRot);
    const src: ParsedBrick[] = [at('973', 71, 0, 0, 0), at('3626c', 14, 0, -24, 0), at('3815', 1, 0, 32, 0), at('3816', 1, 0, 44, 0), at('3817', 1, 0, 44, 0), hand, item];
    const a = assembleMinifig(src, await meshesFor(src));
    const held = bySlot(a, 'held')[0]!;
    expect(a.rig.boneOf[a.bricks.indexOf(held)]).toBe('hand_right');
    const canon = MINIFIG_CANON.hand_right;
    const expected = [canon.position[0] + canon.rotation[1]! * -10, canon.position[1] + canon.rotation[4]! * -10, canon.position[2] + canon.rotation[7]! * -10];
    expect([held.x, held.y, held.z].map(v => Math.round(v * 100) / 100)).toEqual(expected.map(v => Math.round(v * 100) / 100));
  });

  it('builds a figure from a spec with a cape and a held item', () => {
    const a = minifigFromSpec({ torso: { part: '973', color: 4 }, head: { part: '3626c', color: 14 }, hair: { part: '3901', color: 0 }, legs: { color: 1 }, cape: { color: 4 }, heldRight: { part: '3836', color: 70 } });
    expect(a.bricks.map(b => b.part)).toEqual(['973', '3626c', '3901', '3815', '3816', '3817', '3818', '3819', '3820', '3820', '3836', '4524']);
    expect(bySlot(a, 'hips')[0]!.color).toBe(1);
    expect(bySlot(a, 'arm_left')[0]!.color).toBe(4);
    expect(a.rig.boneOf[10]).toBe('hand_right');
    expect(a.rig.boneOf[11]).toBe('body');
  });
});

describe('the rig through the entity compiler', () => {
  it('emits one bone per joint with pivots at the joints, parents in order, and legs that reach the floor', async () => {
    const a = minifigFromSpec({ torso: { part: '973', color: 4 }, hair: { part: '3901', color: 0 } });
    const geo = await compileLdrawEntityGeometry('fig', 'figure', a.bricks, { partGeometry: provider(), rig: a.rig, frame: ldrawToRenderRotation('-z'), quality: { studFacets: 1 } });
    const meshes = (geo.value as { 'minecraft:geometry': Array<{ bones: Array<{ name: string; parent?: string; pivot: number[]; cubes: unknown[] }> }> })['minecraft:geometry'];
    expect(meshes).toHaveLength(1);
    const bones = meshes[0]!.bones;
    const names = bones.map(b => b.name);
    for (const rb of MINIFIG_BONES) expect(names).toContain(rb.name);
    const byName = new Map(bones.map(b => [b.name, b]));
    expect(byName.get('leg_right')!.parent).toBe('hips');
    expect(byName.get('hand_left')!.parent).toBe('arm_left');
    expect(byName.get('head')!.parent).toBe('body');
    // Parents come before children.
    for (const b of bones) if (b.parent) expect(names.indexOf(b.parent)).toBeLessThan(names.indexOf(b.name));
    // Pivots: feet on the floor (y 0), so the hip joint sits at (72 − 44) LDU × 0.3 = 8.4 units, the neck at (72 + 24) × 0.3 = 28.8.
    expect(byName.get('leg_right')!.pivot[1]).toBeCloseTo((MINIFIG_FEET_Y - 44) * 0.3, 1);
    expect(byName.get('head')!.pivot[1]).toBeCloseTo((MINIFIG_FEET_Y + 24) * 0.3, 1);
    // The right arm's pivot is at the figure's right: LDraw −X → render +X → JSON −X.
    expect(byName.get('arm_right')!.pivot[0]).toBeCloseTo(-15.552 * 0.3, 1);
    // The turned arms are child bones of their rig bone, so the walk animation moves them.
    const armChildren = bones.filter(b => b.parent === 'arm_right');
    expect(armChildren.length).toBeGreaterThanOrEqual(1);
    expect(armChildren[0]!.cubes.length).toBeGreaterThan(0);
    // The figure stands 96 LDU = 1.8 blocks tall, hair aside.
    expect(geo.sizeBlocks.height).toBeGreaterThanOrEqual(1.8);
    expect(geo.sizeBlocks.height).toBeLessThan(2.05);
    expect(geo.facing).toBe('-z');
  });

  it('ships walk, look and sit animations that only touch rig bones', () => {
    const anims = MINIFIG_ANIMATIONS.animations as Record<string, { bones: Record<string, unknown> }>;
    const rigNames = new Set(MINIFIG_BONES.map(b => b.name));
    for (const a of Object.values(anims)) for (const bone of Object.keys(a.bones)) expect(rigNames.has(bone)).toBe(true);
    expect(MINIFIG_CLIENT_ANIMATIONS.animate).toContainEqual({ walk: '!query.is_riding' });
  });
});
