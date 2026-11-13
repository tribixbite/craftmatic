/**
 * LSCALE (BIZ-05 / BIZ-10 / BIZ-11): landmark detail by size. A bigger Brick Wand step selects a FINER design (more
 * studs per metre), not the same model scaled up. Rendered by `bun scripts/_landmark_levels.ts` into `output/lscale/`.
 */
import { describe, expect, it } from 'vitest';
import { SIZE_STEPS } from '../web/src/engine/bedrock-placement-pack.js';
import { BLOCKS_PER_STUD, DETAIL_LEVELS, WAND_STEPS, levelForSizePct, scaleRequestForLevel, sizeLadder } from '../web/src/brickgen/levels/levels.js';
import { roseTracery, pinnacleStages } from '../web/src/brickgen/levels/detail.js';
import { roseMask } from '../web/src/brickgen/grammar/arch.js';
import { suggestSize } from '../web/src/brickgen/levels/suggest.js';
import { lintText } from '../web/src/engine/pack-text/lint.js';
import { chooseScale, type MetreVolume } from '../web/src/brickgen/massing/scale.js';

/** A cathedral-sized volume: 135 x 48 m footprint, 96 m tall (Notre-Dame's real extent, metres). */
const CATHEDRAL: MetreVolume[] = [{
  outer: [[0, 0], [135, 0], [135, 48], [0, 48]], holes: [], baseM: 0, topM: 96,
}];

describe('brickgen-levels: a requested level is honoured exactly', () => {
  it('the default request clamps a 4 studs per metre cathedral; a level request does not', () => {
    expect(chooseScale(CATHEDRAL, { target: 4 }).studsPerMetre).toBeLessThan(4);
    for (const level of DETAIL_LEVELS) {
      const s = chooseScale(CATHEDRAL, scaleRequestForLevel(level));
      expect(s.studsPerMetre).toBe(level.studsPerMetre);
      expect(s.reason).not.toMatch(/clamped/);
    }
  });
});

describe('brickgen-levels: wand steps select levels', () => {
  it('the ladder uses the wand\'s real steps', () => {
    expect([...WAND_STEPS]).toEqual([...SIZE_STEPS]);
  });
  it('picks the finest level at most pct / 100 studs per metre', () => {
    const at = Object.fromEntries(WAND_STEPS.map(p => [p, levelForSizePct(p).studsPerMetre]));
    expect(at).toEqual({ 25: 1, 50: 1, 75: 1, 100: 1, 150: 1, 200: 2, 300: 2, 400: 4 });
  });
  it('a finer level is never shown below its own 100 percent, and every rung keeps its real size', () => {
    for (const r of sizeLadder()) {
      if (r.pct >= 100) expect(r.factor).toBeGreaterThanOrEqual(1);
      // studs per metre x wand factor x blocks per stud = blocks per metre, whatever the level
      expect(r.level.studsPerMetre * r.factor * BLOCKS_PER_STUD).toBeCloseTo(r.blocksPerMetre, 9);
    }
    expect(sizeLadder().find(r => r.pct === 300)!.factor).toBe(1.5);
  });
  it('a stud is 0.375 blocks (53.33 LDU per block at the 1x model scale)', () => {
    expect(BLOCKS_PER_STUD).toBeCloseTo(0.375, 9);
  });
});

describe('brickgen-levels: pinnacle stages', () => {
  it('a base of 8 studs steps in one stud a side per course down to its 4-stud cap, courses sharing the height', () => {
    const s = pinnacleStages(8, 4, 24);
    expect(s.map(c => c.inset)).toEqual([0, 1, 2]);
    expect(s[0]!.p0).toBe(0);
    expect(s[s.length - 1]!.p1).toBe(24);
    for (let k = 1; k < s.length; k++) expect(s[k]!.p0).toBe(s[k - 1]!.p1);
  });
  it('a base under 5 studs is one straight course (level 1 output is unchanged)', () => {
    expect(pinnacleStages(3, 2, 10)).toEqual([{ inset: 0, p0: 0, p1: 10 }]);
    expect(pinnacleStages(4, 4, 10)).toEqual([{ inset: 0, p0: 0, p1: 10 }]);
  });
  it('a short shaft drops its lowest steps instead of making a thin ledge', () => {
    const s = pinnacleStages(10, 2, 7);
    expect(s.length).toBe(2);
    expect(s.every(c => c.p1 - c.p0 >= 3)).toBe(true);
    expect(s[s.length - 1]!.inset).toBe(4); // the course under the cap is 2 studs wide: 10 - 2 * 4
  });
});

describe('brickgen-levels: rose tracery', () => {
  const t = roseTracery(20, 2.5);
  it('divides the disc into several panes and never leaves the disc', () => {
    const plain = roseMask(20, 2.5, 3);
    const count = (m: Uint8Array): number => m.reduce((a, b) => a + b, 0);
    expect(count(t.bars)).toBeGreaterThan(count(plain.bars));
    for (let i = 0; i < t.mask.length; i++) expect(t.mask[i]! & t.bars[i]!).toBe(0);
    // Open panes: more than the plain rose's three-bar split gives (count 8-connected components of open cells).
    const panes = (m: Uint8Array, w: number, h: number): number => {
      const seen = new Uint8Array(m.length); let n = 0;
      for (let s = 0; s < m.length; s++) {
        if (!m[s] || seen[s]) continue;
        n++; const stack = [s]; seen[s] = 1;
        while (stack.length) {
          const c = stack.pop()!, x = c % w, y = Math.floor(c / w);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const k = ny * w + nx; if (m[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
          }
        }
      }
      return n;
    };
    expect(panes(t.mask, t.w, t.h)).toBeGreaterThan(panes(plain.mask, plain.w, plain.h));
  });
  it('is symmetric left to right and top to bottom', () => {
    for (let row = 0; row < t.h; row++) for (let col = 0; col < t.w; col++) {
      expect(t.bars[row * t.w + col]).toBe(t.bars[row * t.w + (t.w - 1 - col)]);
      expect(t.bars[row * t.w + col]).toBe(t.bars[(t.h - 1 - row) * t.w + col]);
    }
  });
});

describe('brickgen-levels: size suggestion', () => {
  const extent = { x: 135, y: 96, z: 48 };
  const MAX = { maxResidentCuboids: 60_000, maxUncompressedBytes: 25 * 1024 * 1024 };
  const cost = (studsPerMetre: number, residentCuboids: number, mb: number) => ({ studsPerMetre, residentCuboids, uncompressedBytes: mb * 1024 * 1024 });

  it('suggests the smallest step of the finest level whose pack fits cuboids AND bytes', () => {
    // Notre-Dame as measured: level 2 ships 28 thousand cuboids but 26 MB (over the 25 MiB limit).
    const s = suggestSize({ extent, costs: [cost(1, 15_001, 9.4), cost(2, 28_193, 26), cost(4, 90_000, 100)], ...MAX });
    expect(s.level.studsPerMetre).toBe(1);
    expect(s.pct).toBe(100);
    const fits = suggestSize({ extent, costs: [cost(1, 15_001, 9.4), cost(2, 28_193, 20)], ...MAX });
    expect(fits.level.studsPerMetre).toBe(2);
    expect(fits.pct).toBe(200);
  });
  it('with no measured cost at all it offers only the coarsest level, at its own 100 percent', () => {
    const s = suggestSize({ extent, costs: [], ...MAX });
    expect([s.level.studsPerMetre, s.pct]).toEqual([1, 100]);
  });
  it('never offers a level with no measured cost', () => {
    expect(suggestSize({ extent, costs: [cost(1, 15_001, 9.4)], ...MAX }).level.studsPerMetre).toBe(1);
  });
  it('steps down when the clear space is smaller than the footprint, and says so', () => {
    const costs = [cost(1, 15_001, 9.4), cost(2, 28_193, 20), cost(4, 50_000, 24)];
    const roomy = suggestSize({ extent, costs, ...MAX, availableBlocks: 1000 });
    expect(roomy.level.studsPerMetre).toBe(4);
    const tight = suggestSize({ extent, costs, ...MAX, availableBlocks: 60 });
    expect(tight.level.studsPerMetre).toBe(1);
    expect(tight.text).toContain('fits your clear space');
    const none = suggestSize({ extent, costs, ...MAX, availableBlocks: 10 });
    expect(none.text).toContain('largest that fits');
  });
  it('speaks the pack\'s own percent and the text passes the marketplace lint', () => {
    const costs = [cost(1, 15_001, 9.4), cost(2, 28_193, 20)];
    const own = suggestSize({ extent, costs, ...MAX, forPack: DETAIL_LEVELS[1]! });
    expect(own.text).toMatch(/^Suggested size: 100 percent here, as big as 200 percent of the standard design\./);
    const other = suggestSize({ extent, costs, ...MAX, forPack: DETAIL_LEVELS[0]! });
    expect(other.text).toMatch(/^Suggested: the 2-stud pack at 100 percent\./);
    for (const t of [own.text, other.text]) expect(lintText(t, { surface: 'prose' })).toEqual([]);
  });
});
