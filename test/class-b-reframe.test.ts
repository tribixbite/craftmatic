import { describe, expect, it } from 'vitest';
import { CLASS_B_REFRAME } from '../web/src/engine/class-b-reframe-generated.js';
import {
  CLASS_B_STAMP, hasClassBReframe, reframeClassB, reframeLdrawText, reframeStem,
} from '../web/src/engine/class-b-reframe.js';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** 90 deg about Y, row-major: x' = z, z' = -x. */
const RY90 = [0, 0, 1, 0, 1, 0, -1, 0, 0];

describe('class-B re-frame (Studio copy -> upstream copy of the same mould)', () => {
  it('carries the measured rows: 70681 is the same mould 20 LDU along +Z, 10313 a quarter turn', () => {
    // docs/lego-sources-guide.md §7a; the audit had called 70681 "a different part upstream".
    expect(CLASS_B_REFRAME['70681']).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 19.999]);
    expect(CLASS_B_REFRAME['10313']!.slice(0, 9)).toEqual(RY90);
    // No row is a no-op and none names a mould the census called `different`.
    for (const [stem, row] of Object.entries(CLASS_B_REFRAME)) {
      expect(row, stem).toHaveLength(12);
      const noOp = row.slice(0, 9).every((v, i) => v === I[i]) && row.slice(9).every(v => Math.abs(v) < 0.5);
      expect(noOp, `${stem} is an identity row`).toBe(false);
    }
  });

  it('keys by stem, case- and path-insensitively, and answers null for every other part', () => {
    expect(reframeStem('parts\\70681.DAT')).toBe('70681');
    expect(hasClassBReframe('70681.dat')).toBe(true);
    expect(hasClassBReframe('3001.dat')).toBe(false);
    expect(reframeClassB('3001.dat', I, 1, 2, 3)).toBeNull();
  });

  it("moves the origin by R·t and turns by R·Q, so the upstream mesh lands where Studio's did", () => {
    // Identity placement: the shift is applied as is.
    const shifted = reframeClassB('70681.dat', I, 10, 20, 30)!;
    expect(shifted.rot).toEqual(I);
    expect([shifted.x, shifted.y, shifted.z].map(v => Math.round(v * 1000) / 1000)).toEqual([10, 20, 49.999]);
    // A placement already turned 90 deg about Y carries the shift through its own frame: R·(0,0,20) = (20,0,0).
    const turned = reframeClassB('70681.dat', RY90, 0, 0, 0)!;
    expect(turned.rot).toEqual(RY90);
    expect([turned.x, turned.y, turned.z].map(v => Math.round(v * 1000) / 1000)).toEqual([19.999, 0, 0]);
    // A rotated row composes: R' = R·Q.
    const r = reframeClassB('10313.dat', I, 0, 0, 0)!;
    expect(r.rot).toEqual(RY90);
    expect([r.x, r.y, r.z]).toEqual([10, -16.225, 9.5]);
  });

  it('re-frames only the type-1 lines of a Studio-frame text that name a table part, byte-for-byte otherwise', () => {
    const text = [
      '0 FILE model.ldr',
      '0 Name: model.ldr',
      '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
      '1 71 100 -24 40 1 0 0 0 1 0 0 0 1 70681.dat',
      '1 16 0 0 0 1 0 0 0 1 0 0 0 1 submodel.ldr',
      '4 4 0 0 0 20 0 0 20 0 20 0 0 20',
    ].join('\n');
    const { text: out, moved } = reframeLdrawText(text);
    expect(moved).toBe(1);
    const lines = out.split('\n');
    expect(lines[2]).toBe('1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat');
    expect(lines[3]).toBe('1 71 100 -24 59.999 1 0 0 0 1 0 0 0 1 70681.dat');
    expect(lines[4]).toBe('1 16 0 0 0 1 0 0 0 1 0 0 0 1 submodel.ldr');
    expect(lines[5]).toBe('4 4 0 0 0 20 0 0 20 0 20 0 0 20');
  });

  it("leaves a text clego already re-framed alone, so a corpus file is never moved twice", () => {
    const stamped = `0 Name: x\n${CLASS_B_STAMP} v1 moved=3\n1 71 100 -24 40 1 0 0 0 1 0 0 0 1 70681.dat`;
    expect(reframeLdrawText(stamped)).toEqual({ text: stamped, moved: 0 });
  });
});
