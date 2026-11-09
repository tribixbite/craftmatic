/**
 * X-08 (BIZ-09): BrickPlan -> MPD writer, the `!CRAFTMATIC` authoring metas and
 * their registration in the directive table + parser.
 */
import { describe, expect, it } from 'vitest';
import { classifyDirective } from '../web/src/engine/ldraw-directives.js';
import { parseLDrawDocument, parseAuthoringMeta } from '../web/src/engine/ldraw-parser.js';
import { formatAuthoringMeta, turnMatrix, writeLdraw, PLACEHOLDER_IDENTITY } from '../web/src/brickgen/emit/ldraw-writer.js';
import type { AuthoringMeta, BrickPlan, PlacedElement } from '../web/src/brickgen/types.js';

const SCALE = { studsPerMetre: 1, platesPerMetre: 2.5, reason: 'test' };

function plan(elements: PlacedElement[], metas: AuthoringMeta[] = []): BrickPlan {
  return { elements, groups: [{ id: 'walls', label: 'Walls' }, { id: 'base', label: 'Base' }], scale: SCALE, metas };
}

const SAMPLE: PlacedElement[] = [
  { part: '3001.dat', colour: 4, at: [0, 0, 0], turn: 0, group: 'base' },
  { part: '3001.dat', colour: 14, at: [2, 3, 1], turn: 1, group: 'walls' },
  { part: '3040b.dat', colour: 15, at: [1, 6, 0], turn: 2, group: 'walls' },
  { part: '3659.dat', colour: 1, at: [4, 0, 3], turn: 3, group: 'base' },
  { part: '11477.dat', colour: 25, at: [0, 9, 5], turn: 0, group: 'walls' },
];

describe('brickgen-ldraw-writer', () => {
  it('a written plan parses back through parseLDrawDocument to the same parts, colours and positions', () => {
    const doc = parseLDrawDocument(writeLdraw(plan(SAMPLE)));
    expect(doc.bricks).toHaveLength(SAMPLE.length);
    const find = (part: string, colour: number) => doc.bricks.find(b => b.part === part && b.color === colour)!;
    // 3001 (4x2, body top at origin, bottom 24 below): footprint centre (40,20), body bottom on y = 0.
    const a = find('3001.dat', 4);
    expect([a.x, a.y, a.z]).toEqual([40, -24, 20]);
    // Turned once the footprint is 2 in x and 4 in z; at (2,3,1): centre x = 2*20+20, z = 1*20+40; floor at plate 3.
    const b = find('3001.dat', 14);
    expect([b.x, b.y, b.z]).toEqual([60, -3 * 8 - 24, 60]);
    // 3659 arch 4x1, turn 3: 1 in x, 4 in z; centre x = 4*20+10, z = 3*20+40.
    const c = find('3659.dat', 1);
    expect([c.x, c.y, c.z]).toEqual([90, -24, 100]);
    // A curved slope has its origin at its bottom (frame.bottomY 0): the body floor is plate 9.
    const d = find('11477.dat', 25);
    expect(d.y).toBe(-9 * 8);
    // Every body is recoverable by cell: nothing lands off the lattice.
    for (const k of doc.bricks) {
      expect(Number.isInteger(k.x * 4)).toBe(true);
      expect(k.sourcePath).toHaveLength(2); // model -> group file
    }
  });

  it('the same plan writes byte-identical text twice, whatever the input order', () => {
    const one = writeLdraw(plan(SAMPLE));
    const two = writeLdraw(plan(SAMPLE));
    expect(two).toBe(one);
    const shuffled = writeLdraw({ ...plan([...SAMPLE].reverse()), groups: [{ id: 'base', label: 'Base' }, { id: 'walls', label: 'Walls' }] });
    expect(shuffled).toBe(one);
    expect(one).not.toContain('\r');
    expect(one.endsWith('\n')).toBe(true);
    expect(one.startsWith('0 FILE design.ldr\n')).toBe(true);
    expect(one).toContain('0 Author: ' + PLACEHOLDER_IDENTITY.author);
    expect(one).toContain('0 !LICENSE ' + PLACEHOLDER_IDENTITY.licence);
    // One FILE section per group plus the model, groups in id order, elements bottom layer first.
    expect([...one.matchAll(/^0 FILE (.*)$/gm)].map(m => m[1])).toEqual(['design.ldr', 'design-base.ldr', 'design-walls.ldr']);
    const walls = one.split('0 FILE design-walls.ldr')[1]!.split('\n').filter(l => l.startsWith('1 '));
    expect(walls.map(l => l.split(' ').pop())).toEqual(['3001.dat', '3040b.dat', '11477.dat']);
  });

  it('a turn of 1 writes the exact quarter-turn matrix', () => {
    expect(turnMatrix(0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(turnMatrix(1)).toEqual([0, 0, 1, 0, 1, 0, -1, 0, 0]);
    // Four quarter turns compose to the identity, exactly.
    const mul = (p: readonly number[], q: readonly number[]): number[] => {
      const r: number[] = [];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(p[i * 3]! * q[j]! + p[i * 3 + 1]! * q[3 + j]! + p[i * 3 + 2]! * q[6 + j]!);
      return r;
    };
    let m: number[] = [...turnMatrix(0)];
    for (let i = 0; i < 4; i++) m = mul(m, turnMatrix(1));
    expect(m.map(v => v + 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(mul(turnMatrix(1), turnMatrix(1))).toEqual([...turnMatrix(2)]);
    expect(mul(turnMatrix(2), turnMatrix(1))).toEqual([...turnMatrix(3)]);
    const text = writeLdraw(plan([{ part: '3001.dat', colour: 4, at: [0, 0, 0], turn: 1, group: 'base' }]));
    expect(text).toContain('1 4 20 -24 40 0 0 1 0 1 0 -1 0 0 3001.dat');
    const doc = parseLDrawDocument(text);
    expect(doc.bricks[0]!.rot).toEqual([0, 0, 1, 0, 1, 0, -1, 0, 0]);
  });

  it('FIGURE and SEAT metas survive the round trip', () => {
    const metas: AuthoringMeta[] = [
      { kind: 'FIGURE', system: 'brickling', at: [100, -24, 40], facingDeg: 90, seat: 'bench1' },
      { kind: 'FIGURE', system: 'brickling', at: [0, 0, 0], facingDeg: 270.5 },
      { kind: 'SEAT', id: 'bench1', at: [100, -24, 40], facingDeg: 180 },
      { kind: 'DOOR', group: 'walls', hinge: [20, -48, 0], axis: 'y', openDeg: 90 },
      { kind: 'SPAWN', at: [10, 0, -10] },
      { kind: 'DESIGN', slug: 'town-hall', version: '1.2.0', provenance: 'logs/town-hall.json rev 3' },
    ];
    const text = writeLdraw(plan(SAMPLE, metas));
    const doc = parseLDrawDocument(text);
    expect(doc.metas).toEqual(metas);
    // In a flat file the metas also ride on the next placed part, like headPrint.
    const flat = parseLDrawDocument(['0 !CRAFTMATIC SEAT s1 1 2 3 90', '0 !CRAFTMATIC SPAWN 0 0 0',
      '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat', '1 4 20 0 0 1 0 0 0 1 0 0 0 1 3001.dat'].join(String.fromCharCode(10)));
    expect(flat.bricks[0]!.authoringMetas).toEqual([
      { kind: 'SEAT', id: 's1', at: [1, 2, 3], facingDeg: 90 }, { kind: 'SPAWN', at: [0, 0, 0] }]);
    expect(flat.bricks[1]!.authoringMetas).toBeUndefined();
    // format <-> parse are inverses.
    for (const m of metas) expect(parseAuthoringMeta(formatAuthoringMeta(m))).toEqual(m);
    // A damaged meta is ignored, never thrown.
    expect(parseAuthoringMeta('0 !CRAFTMATIC SPAWN 1 two 3')).toBeNull();
    expect(parseAuthoringMeta('0 !CRAFTMATIC DOOR g 1 2 3 x 90')).toBeNull();
    expect(parseAuthoringMeta('0 !CRAFTMATIC HEAD_PRINT 3626pb1')).toBeNull();
  });

  it('every authoring meta is registered in the directive table and handled', () => {
    for (const kind of ['FIGURE', 'SEAT', 'DOOR', 'SPAWN', 'DESIGN']) {
      const spec = classifyDirective(`0 !CRAFTMATIC ${kind} x`);
      expect(spec, kind).not.toBe('unknown');
      expect(spec, kind).not.toBeNull();
      expect(typeof spec === 'object' && spec !== null && spec.handled, kind).toBe(true);
    }
  });

  it('refuses a part outside the vocabulary, an undeclared group and colliding group files', () => {
    expect(() => writeLdraw(plan([{ part: 'bl_3001.dat', colour: 4, at: [0, 0, 0], turn: 0, group: 'base' }]))).toThrow(/not in the vocabulary/);
    expect(() => writeLdraw(plan([{ part: '3001.dat', colour: 4, at: [0, 0, 0], turn: 0, group: 'nope' }]))).toThrow(/undeclared group/);
    expect(() => writeLdraw({ ...plan([]), groups: [{ id: 'A b', label: 'x' }, { id: 'a_b', label: 'y' }] })).toThrow(/collapse/);
  });
});
