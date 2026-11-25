/**
 * PROC-20, Pixel round 24a: 21065 Sagrada Familia at 400 % was drawn from 30 blocks off its front and NOT AT ALL from
 * 50 and 60 (empty sky): every shell chunk's root was past the ~70-block actor draw ceiling. The simulator's walk-away
 * already predicted it (0 drawn from 40 blocks) but only REPORTED the full/hull/gone counts. `vanishVerdict` makes it
 * a violation: the model may not disappear whole while the child stands within `VANISH_EDGE_BLOCKS` (30) of its edge; past
 * that the ~64-block actor cull takes every actor, so 21065's 50-block loss is the ceiling, not this fault.
 */
import { describe, expect, it } from 'vitest';
import { VANISH_EDGE_BLOCKS, vanishVerdict } from '../web/src/sim/adapters/craftmatic/client-steps.js';

describe('sim walk-away: the model never vanishes whole within sight (model-vanishes, PROC-20)', () => {
  it('a model that draws nothing from 20 blocks off its corner is a violation (10354 at 400 percent: 0 of its shell)', () => {
    const rows = [20, 31, 42].map(d => ({ distance: d, shellDrawn: 0, shellTotal: 23 }));
    expect(vanishVerdict(rows)?.distance).toBe(20);
  });

  it('gone only past the 30-block limit is the actor cull, not a fault (21065 at 400 percent: drawn at 20 and 30, gone from 40)', () => {
    const rows = [20, 30, 40, 50, 60, 70].map(d => ({ distance: d, shellDrawn: d <= 30 ? (d === 20 ? 3 : 1) : 0, shellTotal: 12 }));
    expect(vanishVerdict(rows)).toBeUndefined();
  });

  it('a model that hulls or draws out to the edge limit, or vanishes only past it, passes', () => {
    expect(vanishVerdict([40, 50, 60].map(d => ({ distance: d, shellDrawn: 2, shellTotal: 5 })))).toBeUndefined();
    expect(vanishVerdict([{ distance: VANISH_EDGE_BLOCKS + 10, shellDrawn: 0, shellTotal: 5 }])).toBeUndefined();
  });

  it('a pack with no shell is not judged', () => {
    expect(vanishVerdict([{ distance: 20, shellDrawn: 0, shellTotal: 0 }])).toBeUndefined();
  });
});
