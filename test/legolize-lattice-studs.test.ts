/**
 * X-12 follow-up to X-11 (BIZ-33): LDraw studs are cylinders OPEN at the bottom (a side wall and a top
 * disc, no base) standing on a brick's top face. A ray through one crosses the shell an ODD number of
 * times, so an even-odd fill read every cell above a stud as inside: a floating brick's column of
 * "solid" up to the model's top, and a merged-mesh lattice that disagreed with the per-brick one.
 * Measured on the library part 3001: ray up a stud's off-axis line hits y = -4, 0, 4 (three crossings).
 */
import { describe, it, expect } from 'vitest';
import { latticeFromBricks, type BrickLike, type TriangleLike } from '../web/src/engine/legolize/lattice.js';
import { latticeIndex, type IntentLattice } from '../web/src/engine/legolize/types.js';

type V3 = [number, number, number];
const p = (x: number, y: number, z: number): V3 => [x, y, z];

/** Closed box [x0,x1] x [y0,y1] x [z0,z1] as 12 triangles. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): TriangleLike[] {
  const quad = (a: V3, b: V3, c: V3, d: V3): TriangleLike[] => [[a, b, c], [a, c, d]];
  return [
    ...quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)),
    ...quad(p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0)),
    ...quad(p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1)),
    ...quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0)),
    ...quad(p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), p(x0, y1, z0)),
    ...quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)),
  ];
}

/** An open-bottomed stud: `n`-gon side wall from y0 to y1 plus a fan top disc at y1. */
function stud(cx: number, cz: number, r: number, y0: number, y1: number, n: number): TriangleLike[] {
  const ring = (i: number, y: number): V3 => p(cx + r * Math.cos((2 * Math.PI * i) / n), y, cz + r * Math.sin((2 * Math.PI * i) / n));
  const out: TriangleLike[] = [];
  for (let i = 0; i < n; i++) {
    out.push([ring(i, y0), ring(i + 1, y0), ring(i + 1, y1)], [ring(i, y0), ring(i + 1, y1), ring(i, y1)]);
    out.push([p(cx, y1, cz), ring(i, y1), ring(i + 1, y1)]);
  }
  return out;
}

const brick = (part: string, y: number): BrickLike => ({ part, color: 4, x: 0, y, z: 0 });
const cell = (l: IntentLattice, x: number, pl: number, z: number): number => l.cells[latticeIndex(l.dims, x, pl, z)]!;

/** Triangles in the LDraw frame (Y down): a 40 x 24 x 40 LDU block, a stud on its top, and a floating plate high above. */
const PARTS: Record<string, TriangleLike[]> = {
  // Lattice y 0..24 is LDraw y 0..-24 (negated by latticeFromBricks). The stud's axis is 3 LDU off the centre of cell (1, 0)
  // so a cell-centre ray crosses its top disc once, not at the fan's apex (where every fan triangle reports a hit).
  studded: [...box(0, -24, 0, 40, 0, 40), ...stud(33, 10, 5, -24, -28, 7)],
  floating: box(0, -64, 0, 40, -56, 40),
};

describe('legolize-lattice open studs', () => {
  it('a stud open at the bottom does not fill the empty column above it', async () => {
    const lat = await latticeFromBricks([brick('studded', 0), brick('floating', 0)], {
      mode: 'solid', partTriangles: async (b) => PARTS[b.part]!,
    });
    // Layers 4..6 (lattice y 32..56) hold nothing: the stud ends at y 28.
    for (const layer of [4, 5, 6]) expect({ layer, filled: cell(lat, 1, layer, 0) }).toEqual({ layer, filled: 0 });
    // The block and the floating plate are still solid.
    expect(cell(lat, 0, 1, 0)).not.toBe(0);
    expect(cell(lat, 0, 7, 0)).not.toBe(0);
  });
});

import { capPlanarHoles } from '../web/src/engine/legolize/hole-cap.js';

describe('hole-cap', () => {
  const flat = (tris: TriangleLike[]): Float32Array => Float32Array.from(tris.flatMap((t) => t.flatMap((v) => [...v])));

  it('a closed box has no loop to cap', () => {
    expect(capPlanarHoles(flat(box(0, 0, 0, 4, 4, 4)))).toBeNull();
  });

  it('an open-bottomed stud is closed by one cap', () => {
    const r = capPlanarHoles(flat(stud(0, 0, 5, 0, 4, 16)))!;
    expect(r.closed).toBe(1);
    expect(r.positions.length).toBe(16 * 9);
  });

  it('a concave planar loop is left open and counted', () => {
    // An L-shaped prism wall with no floor and no roof: both rims are concave.
    const L: V3[] = [p(0, 0, 0), p(2, 0, 0), p(2, 0, 1), p(1, 0, 1), p(1, 0, 2), p(0, 0, 2)];
    const tris: TriangleLike[] = [];
    for (let i = 0; i < L.length; i++) {
      const a = L[i]!, b = L[(i + 1) % L.length]!;
      tris.push([a, b, p(b[0], 1, b[2])], [a, p(b[0], 1, b[2]), p(a[0], 1, a[2])]);
    }
    const r = capPlanarHoles(flat(tris))!;
    expect(r.closed).toBe(0);
    expect(r.skipped).toBe(2);
  });
});
