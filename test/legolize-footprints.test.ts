/** V-02 (BIZ-33): `latticeFromFootprints`, the truth lattice built from each brick's own vocabulary footprint cells. */
import { describe, it, expect } from 'vitest';
import { latticeFromFootprints, type BrickLike, type TriangleLike } from '../web/src/engine/legolize/lattice.js';
import { latticeIndex, type IntentLattice } from '../web/src/engine/legolize/types.js';
import { elementFor } from '../web/src/brickgen/vocab/index.js';

const count = (l: IntentLattice): number => l.cells.reduce((n, c) => n + (c ? 1 : 0), 0);
const at = (l: IntentLattice, x: number, p: number, z: number): boolean => l.cells[latticeIndex(l.dims, x, p, z)] !== 0;
const brick = (part: string, x: number, y: number, z: number, rot?: number[], color = 4): BrickLike => ({ part, color, x, y, z, ...(rot ? { rot } : {}) });
/** Quarter turn about LDraw +y (the writer's turn 1). */
const TURN1 = [0, 0, 1, 0, 1, 0, -1, 0, 0];

describe('latticeFromFootprints', () => {
  it('a 3001 (4 x 2 studs, 3 plates) fills exactly 4 x 3 x 2 cells, and none of its studs', async () => {
    const { lattice, stats } = await latticeFromFootprints([brick('3001.dat', 0, 0, 0)]);
    expect(lattice.dims).toEqual([4, 3, 2]);
    expect(count(lattice)).toBe(24);
    expect(stats).toEqual({ vocabBricks: 1, meshBricks: 0, meshParts: {}, vocabCells: 24, meshCells: 0 });
    expect(lattice.labels).toEqual([{ role: 'solid', colour: 4 }]);
  });

  it('a quarter turn swaps the footprint axes', async () => {
    const { lattice } = await latticeFromFootprints([brick('3001.dat', 0, 0, 0, TURN1)]);
    expect(lattice.dims).toEqual([2, 3, 4]);
    expect(count(lattice)).toBe(24);
  });

  it('a hollow part keeps its voids: 3659 (arch) fills only its occupancy cells, and a turn keeps the count', async () => {
    const occ = elementFor('3659.dat')!.occupancy!;
    const expected = occ.reduce((n, v) => n + v, 0);
    expect(expected).toBeLessThan(occ.length);
    for (const rot of [undefined, TURN1]) {
      const { lattice } = await latticeFromFootprints([brick('3659.dat', 0, 0, 0, rot)]);
      expect(count(lattice)).toBe(expected);
    }
    // Layer 0 of the occupancy is "1001": the two middle cells are the opening, so the lattice has a hole at p=0, x=1.
    const { lattice } = await latticeFromFootprints([brick('3659.dat', 0, 0, 0)]);
    expect(at(lattice, 0, 0, 0)).toBe(true);
    expect(at(lattice, 1, 0, 0)).toBe(false);
  });

  it('places a body-offset part by its body: a 3039 (body centre z -10) beside a 3003 lands on the same two stud rows', async () => {
    // 3003 at x 0 covers world x -20..20; the slope at x 40 covers 20..60 with its body centred at z = 10 - 10 = 0.
    const { lattice } = await latticeFromFootprints([brick('3003.dat', 0, 0, 0), brick('3039.dat', 40, 0, 10, undefined, 1)]);
    expect(lattice.dims).toEqual([4, 3, 2]);
    expect(lattice.labels.map((l) => l.colour).sort()).toEqual([1, 4]);
  });

  it('stacks on the plate grid: a brick 24 LDU above another starts 3 layers higher', async () => {
    const { lattice } = await latticeFromFootprints([brick('3003.dat', 0, 0, 0), brick('3003.dat', 0, -24, 0)]);
    expect(lattice.dims).toEqual([2, 6, 2]);
    expect(count(lattice)).toBe(24);
  });

  it('counts a part outside the vocabulary as a mesh brick and voxelises its triangles onto the same grid', async () => {
    // 40 x 24 x 40 LDU closed box (LDraw y down) sitting on top of a 3003 (origin-centred, x and z -20..20): y in [-24, 0].
    const [x0, x1, y0, y1, z0, z1] = [-20, 20, -24, 0, -20, 20];
    const P = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
    const c = [P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)];
    const quads = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    const tris: TriangleLike[] = quads.flatMap(([a, b, cc, d]) => [[c[a!]!, c[b!]!, c[cc!]!], [c[a!]!, c[cc!]!, c[d!]!]]);
    const { lattice, stats } = await latticeFromFootprints(
      [brick('3003.dat', 0, 0, 0), brick('99999.dat', 0, 0, 0, undefined, 1)],
      { partTriangles: async () => tris },
    );
    expect(stats.vocabBricks).toBe(1);
    expect(stats.meshBricks).toBe(1);
    expect(stats.meshParts).toEqual({ '99999': 1 });
    expect(lattice.dims).toEqual([2, 6, 2]);
    expect(count(lattice)).toBe(24);
    expect(at(lattice, 0, 5, 0)).toBe(true);
  });

  it('sends a brick tilted off the quarter-turn grid to the mesh fallback', async () => {
    const s = Math.SQRT1_2;
    const tilted = [1, 0, 0, 0, s, -s, 0, s, s];
    let asked = 0;
    const { stats } = await latticeFromFootprints([brick('3003.dat', 0, 0, 0), brick('3003.dat', 100, 0, 0, tilted)], {
      partTriangles: async () => { asked++; return []; },
    });
    expect(stats.vocabBricks).toBe(1);
    expect(stats.meshBricks).toBe(1);
    expect(asked).toBe(1);
  });

  it('rejects an empty model', async () => {
    await expect(latticeFromFootprints([])).rejects.toThrow(/no bricks/);
  });
});
