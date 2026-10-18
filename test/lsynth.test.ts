/**
 * LSynth flexible-part synthesis tests (pure text→text + geometry).
 *
 * Most real files ship flex parts already synthesized; this covers the gap —
 * an UNsynthesized SYNTH block (constraints only) — and proves the synthesizer
 * (a) leaves already-synthesized / non-tube blocks untouched (can't break
 * working files) and (b) generates a valid swept tube that passes through the
 * constraints. Offline/deterministic.
 */

import { describe, it, expect } from 'vitest';
import { synthesizeLSynth, sampleSpline, sweepTube } from '../web/src/engine/lsynth.js';

const I = '1 0 0 0 1 0 0 0 1';

describe('synthesizeLSynth — block handling', () => {
  it('leaves a file with no SYNTH blocks byte-identical', () => {
    const t = `0 FILE x.ldr\n1 4 0 0 0 ${I} 3001.dat\n`;
    const r = synthesizeLSynth(t);
    expect(r.count).toBe(0);
    expect(r.text).toBe(t);
  });

  it('leaves an ALREADY-synthesized block untouched (count 0)', () => {
    const t = [
      '0 SYNTH BEGIN TECHNIC_FLEX-SYSTEM_HOSE 0',
      '1 4 0 0 0 1 0 0 0 1 0 0 0 1 LS02.dat',
      '0 SYNTH SYNTHESIZED BEGIN',
      '1 16 0 0 0 1 0 0 0 1 0 0 0 1 752.dat',
      '0 SYNTH SYNTHESIZED END',
      '0 SYNTH END',
    ].join('\n');
    const r = synthesizeLSynth(t);
    expect(r.count).toBe(0);
    expect(r.text).toBe(t);
  });

  it('leaves a band/chain block untouched (not a swept tube)', () => {
    const t = [
      '0 SYNTH BEGIN RUBBER_BAND 0',
      `1 0 0 0 0 ${I} 3641.dat`,
      `1 0 40 0 0 ${I} 3641.dat`,
      '0 SYNTH END',
    ].join('\n');
    const r = synthesizeLSynth(t);
    expect(r.count).toBe(0);
    expect(r.text).toContain('SYNTH BEGIN RUBBER_BAND');
  });

  it('synthesizes a hose block → reference + generated inline tube part', () => {
    const t = [
      '0 FILE main.ldr',
      `1 4 0 0 0 ${I} 3001.dat`,
      '0 SYNTH BEGIN TECHNIC_FLEX-SYSTEM_HOSE 4',
      '0 SYNTH SHOW',
      `1 4 0 0 0 ${I} LS00.dat`,
      `1 4 0 0 100 ${I} LS00.dat`,
      `1 4 0 60 200 ${I} LS00.dat`,
      '0 SYNTH END',
    ].join('\n');
    const r = synthesizeLSynth(t);
    expect(r.count).toBe(1);
    // The SYNTH block is gone; a colour-4 reference to a generated part remains.
    expect(r.text).not.toContain('SYNTH BEGIN');
    expect(r.text).not.toContain('LS00.dat');
    const ref = r.text.match(/^1 4 0 0 0 1 0 0 0 1 0 0 0 1 (lsynth-\d+\.dat)$/m);
    expect(ref).toBeTruthy();
    const name = ref![1];
    // The generated inline FILE exists and has triangle geometry.
    expect(r.text).toContain(`0 FILE ${name}`);
    const tris = (r.text.split(`0 FILE ${name}`)[1].match(/^3 16 /gm) ?? []).length;
    expect(tris).toBeGreaterThan(50); // a real swept tube, not a stub
  });

  it('keeps a hose block with <2 constraints verbatim', () => {
    const t = [
      '0 SYNTH BEGIN TECHNIC_FLEX-SYSTEM_HOSE 4',
      `1 4 0 0 0 ${I} LS00.dat`,
      '0 SYNTH END',
    ].join('\n');
    expect(synthesizeLSynth(t).count).toBe(0);
  });
});

describe('sampleSpline', () => {
  it('passes through both endpoints', () => {
    const pts: [number, number, number][] = [[0, 0, 0], [50, 0, 0], [50, 50, 0]];
    const s = sampleSpline(pts, 5);
    expect(s[0]).toEqual([0, 0, 0]);
    expect(s[s.length - 1]).toEqual([50, 50, 0]);
  });

  it('samples a straight segment at ~spacing intervals', () => {
    const s = sampleSpline([[0, 0, 0], [100, 0, 0]], 10);
    expect(s.length).toBe(11); // 100/10 + 1
    expect(s[5][0]).toBeCloseTo(50, 3);
  });
});

describe('sweepTube', () => {
  it('produces sides·2·(rings-1) wall tris + 2·sides cap tris, all radius-R from the axis', () => {
    const path: [number, number, number][] = [[0, 0, 0], [10, 0, 0], [20, 0, 0]];
    const R = 4, sides = 8;
    const lines = sweepTube(path, R, sides);
    const wall = sides * 2 * (path.length - 1);
    const caps = 2 * sides;
    expect(lines.length).toBe(wall + caps);
    // Every wall vertex sits at distance R from the tube axis (the x-axis here).
    for (const l of lines.slice(0, wall)) {
      const v = l.split(/\s+/).slice(2).map(Number); // 3 verts × 3
      for (let k = 0; k < 9; k += 3) {
        const r = Math.hypot(v[k + 1], v[k + 2]); // dist from x-axis (y,z)
        expect(r).toBeCloseTo(R, 2);
      }
    }
  });
});
