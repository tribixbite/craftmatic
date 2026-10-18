import { describe, expect, it } from 'vitest';
import { clipParallelepiped, isAxisAligned, parallelepipedFromCorners } from '../web/src/engine/oriented-box.js';
import { drawnReaches, drawnTopOver, type DrawnBox } from '../web/src/sim/adapters/craftmatic/drawn.js';

/** The eight corners of a cube turned `deg` about +Y around its centre, in `cubeCorners` order (bit 0 x, bit 1 y, bit 2 z). */
function turnedCorners(cx: number, cz: number, half: number, y0: number, y1: number, deg: number): number[][] {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const out: number[][] = [];
  for (let i = 0; i < 8; i++) {
    const lx = i & 1 ? half : -half, lz = i & 4 ? half : -half;
    out.push([cx + c * lx + s * lz, i & 2 ? y1 : y0, cz - s * lx + c * lz]);
  }
  return out;
}

describe('oriented boxes', () => {
  it('reads a parallelepiped from cube corners and tells a turned one from an aligned one', () => {
    expect(isAxisAligned(parallelepipedFromCorners(turnedCorners(0, 0, 1, 0, 1, 0))!)).toBe(true);
    expect(isAxisAligned(parallelepipedFromCorners(turnedCorners(0, 0, 1, 0, 1, 30))!)).toBe(false);
  });

  it('a plate turned 45 degrees is a diamond: its corner box is not a floor at the corners', () => {
    // A 2 x 2 plate centred at (0, 0), top at y 0.1, turned 45 degrees: its corner box spans +-1.414.
    const k = turnedCorners(0, 0, 1, 0, 0.1, 45);
    const solid = parallelepipedFromCorners(k)!;
    const xs = k.map(p => p[0]!), zs = k.map(p => p[2]!);
    const d: DrawnBox = { box: { x0: Math.min(...xs), y0: 0, z0: Math.min(...zs), x1: Math.max(...xs), y1: 0.1, z1: Math.max(...zs) }, glass: false, solid };
    // Over the centre: the plate's top.
    expect(drawnTopOver(d, -0.3, 0.3, -0.3, 0.3)).toBeCloseTo(0.1, 6);
    // Over the corner of its box (1.2, 1.2): nothing drawn (the diamond's edge is at |x| + |z| = 1.414).
    expect(drawnTopOver(d, 1.0, 1.4, 1.0, 1.4)).toBeUndefined();
    expect(drawnReaches(d, { x0: 1.0, y0: -1, z0: 1.0, x1: 1.4, y1: 1, z1: 1.4 })).toBe(false);
    expect(drawnReaches(d, { x0: -0.2, y0: -1, z0: -0.2, x1: 0.2, y1: 1, z1: 0.2 })).toBe(true);
    // An aligned cube (no `solid`) answers by its box, as before.
    const aligned: DrawnBox = { box: d.box, glass: false };
    expect(drawnTopOver(aligned, 1.0, 1.4, 1.0, 1.4)).toBe(0.1);
  });

  it('clips nothing from a box that misses', () => {
    const p = parallelepipedFromCorners(turnedCorners(0, 0, 1, 0, 1, 20))!;
    expect(clipParallelepiped(p, [5, 0, 5], [6, 1, 6])).toBeNull();
  });
});
