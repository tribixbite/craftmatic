/**
 * Interior light fill (S4) — offline, deterministic, no DOM.
 *
 * The three properties that matter:
 *   1. A SEALED room gets lights.
 *   2. A room open to the outside (a porch, a doorway) does NOT — that air is
 *      reachable from the grid boundary, so it isn't an "enclosed dark interior".
 *   3. With the option OFF nothing calls it, and calling it on a solid model
 *      with no pockets leaves the grid byte-identical (the export byte-identity
 *      gate rests on the pass being a no-op unless it finds a pocket).
 */

import { describe, it, expect } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { addInteriorLights } from '../web/src/engine/light-fill.js';

const STONE = 'minecraft:stone';
const LIGHT = 'minecraft:glowstone';

/** Solid box with a hollow interior, wrapped in a 1-cell air margin. */
function sealedRoom(inner = 4): BlockGrid {
  const n = inner + 4; // air margin + wall on each side
  const g = new BlockGrid(n, n, n);
  // Solid shell from 1..n-2, hollow from 2..n-3.
  for (let y = 1; y <= n - 2; y++)
    for (let z = 1; z <= n - 2; z++)
      for (let x = 1; x <= n - 2; x++) g.set(x, y, z, STONE);
  for (let y = 2; y <= n - 3; y++)
    for (let z = 2; z <= n - 3; z++)
      for (let x = 2; x <= n - 3; x++) g.set(x, y, z, 'minecraft:air');
  return g;
}

function snapshot(g: BlockGrid): Uint16Array {
  return new Uint16Array(g.rawData);
}

function countBlock(g: BlockGrid, block: string): number {
  let n = 0;
  for (let y = 0; y < g.height; y++)
    for (let z = 0; z < g.length; z++)
      for (let x = 0; x < g.width; x++) if (g.get(x, y, z) === block) n++;
  return n;
}

describe('addInteriorLights', () => {
  it('lights a sealed room', () => {
    const g = sealedRoom(4); // 4×4×4 interior = 64 cells
    const r = addInteriorLights(g);
    expect(r.pockets).toBe(1);
    expect(r.lights).toBeGreaterThan(0);
    expect(countBlock(g, LIGHT)).toBe(r.lights);
  });

  it('places lights on the pocket FLOOR, not floating in the middle', () => {
    const g = sealedRoom(6);
    addInteriorLights(g);
    for (let y = 0; y < g.height; y++)
      for (let z = 0; z < g.length; z++)
        for (let x = 0; x < g.width; x++)
          if (g.get(x, y, z) === LIGHT) {
            // The cell below must be solid (never air).
            expect(g.get(x, y - 1, z)).not.toBe('minecraft:air');
          }
  });

  it('spaces lights out instead of carpeting the floor', () => {
    // 12×12×12 interior at x,z ∈ [2,13]: the floor is one level (y=2) and the
    // spacing-6 buckets it touches are x∈{0,1,2} × z∈{0,1,2} → ≤ 9 lights for
    // 144 floor cells. The guarantee is "at most one light per spacing³ box",
    // i.e. a sparse lattice, not an exact minimum separation.
    const g = sealedRoom(12);
    const r = addInteriorLights(g, { spacing: 6 });
    const floorCells = 12 * 12;
    expect(r.lights).toBeGreaterThan(0);
    expect(r.lights).toBeLessThanOrEqual(9);
    expect(r.lights).toBeLessThan(floorCells / 8);
  });

  it('leaves a room OPEN to the outside dark (a porch is not an interior)', () => {
    const g = sealedRoom(4);
    // Punch a doorway through one wall: the interior is now reachable from
    // the boundary, so the flood fill classifies it as exterior air.
    const n = g.width;
    for (let y = 2; y <= 3; y++) g.set(1, y, Math.floor(n / 2), 'minecraft:air');
    const before = snapshot(g);
    const r = addInteriorLights(g);
    expect(r.pockets).toBe(0);
    expect(r.lights).toBe(0);
    expect(g.rawData).toEqual(before);
  });

  it('leaves tiny bubbles alone (below the minimum pocket size)', () => {
    const g = new BlockGrid(5, 5, 5);
    for (let y = 1; y <= 3; y++)
      for (let z = 1; z <= 3; z++)
        for (let x = 1; x <= 3; x++) g.set(x, y, z, STONE);
    g.set(2, 2, 2, 'minecraft:air'); // 1-cell bubble
    const before = snapshot(g);
    const r = addInteriorLights(g);
    expect(r.pockets).toBe(0);
    expect(r.skippedSmall).toBe(1);
    expect(g.rawData).toEqual(before);
  });

  it('is a no-op on a model with no enclosed air at all', () => {
    const g = new BlockGrid(6, 6, 6);
    for (let y = 0; y < 3; y++)
      for (let z = 0; z < 6; z++)
        for (let x = 0; x < 6; x++) g.set(x, y, z, STONE); // solid slab, no pockets
    const before = snapshot(g);
    const r = addInteriorLights(g);
    expect(r).toEqual({ pockets: 0, lights: 0, skippedSmall: 0 });
    expect(g.rawData).toEqual(before);
  });

  it('honours a custom light block', () => {
    const g = sealedRoom(4);
    const r = addInteriorLights(g, { lightBlock: 'minecraft:sea_lantern' });
    expect(r.lights).toBeGreaterThan(0);
    expect(countBlock(g, 'minecraft:sea_lantern')).toBe(r.lights);
    expect(countBlock(g, LIGHT)).toBe(0);
  });

  it('lights two separate sealed rooms independently', () => {
    // Two hollow boxes side by side in one grid, separated by solid stone.
    const g = new BlockGrid(17, 8, 8);
    for (let y = 1; y <= 6; y++)
      for (let z = 1; z <= 6; z++)
        for (let x = 1; x <= 15; x++) g.set(x, y, z, STONE);
    const hollow = (x0: number, x1: number) => {
      for (let y = 2; y <= 5; y++)
        for (let z = 2; z <= 5; z++)
          for (let x = x0; x <= x1; x++) g.set(x, y, z, 'minecraft:air');
    };
    hollow(2, 5);
    hollow(11, 14);
    const r = addInteriorLights(g);
    expect(r.pockets).toBe(2);
    expect(r.lights).toBeGreaterThanOrEqual(2);
  });
});
