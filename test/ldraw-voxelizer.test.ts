/**
 * Offline regression tests for the LDraw → BlockGrid voxelizer
 * (web/src/engine/ldraw-voxelizer.ts), the export half of the LEGO→Minecraft
 * pipeline. Deterministic; no network, no GPU.
 */

import { describe, it, expect } from 'vitest';
import { voxelizeLDraw } from '../web/src/engine/ldraw-voxelizer.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const brick = (part: string, x = 0, y = 0, z = 0, color = 15): ParsedBrick =>
  ({ part, x, y, z, color, rot: I, step: 1 });

describe('voxelizeLDraw — basics', () => {
  it('voxelizes a real brick (3001 = 2×4) into a multi-cell footprint', () => {
    const r = voxelizeLDraw([brick('3001.dat')]);
    expect(r.grid.countNonAir()).toBeGreaterThan(1);
    const { w, l } = r.dimensions;
    // 3001 is 2×4 studs — footprint should span more than one cell on both axes.
    expect(Math.max(w, l)).toBeGreaterThanOrEqual(4);
    expect(Math.min(w, l)).toBeGreaterThanOrEqual(2);
    expect(r.unmappedColors).toEqual([]);
  });

  it('places two separated bricks into distinct regions (block count grows)', () => {
    const one = voxelizeLDraw([brick('3001.dat', 0, 0, 0)]).grid.countNonAir();
    const two = voxelizeLDraw([brick('3001.dat', 0, 0, 0), brick('3001.dat', 0, 0, 200)]).grid.countNonAir();
    expect(two).toBeGreaterThan(one);
  });
});

describe('voxelizeLDraw — primitive filtering (regression)', () => {
  // Technic axle-hole PERIMETER primitives (axlehol8 et al.) are p/ geometry,
  // never standalone parts. The filter once missed the `axlehol*` spelling
  // (it only matched `axlhol`), leaking 578 phantom blocks into 42130 BMW.
  it('skips axle-hole primitives — they add no blocks and no fallback', () => {
    const base = voxelizeLDraw([brick('3001.dat')]);
    const withPrim = voxelizeLDraw([brick('3001.dat'), brick('axlehol8.dat', 0, 0, 200)]);
    expect(withPrim.grid.countNonAir()).toBe(base.grid.countNonAir());
    expect(withPrim.fallbackPartCount).toBe(base.fallbackPartCount);
  });

  it('skips the axle-hole family spellings (axlehole, axl2hole, axl3hol9)', () => {
    const base = voxelizeLDraw([brick('3001.dat')]).grid.countNonAir();
    for (const p of ['axlehole.dat', 'axl2hole.dat', 'axl3hol9.dat', 'axl5hol8.dat']) {
      const withPrim = voxelizeLDraw([brick('3001.dat'), brick(p, 0, 0, 200)]).grid.countNonAir();
      expect(withPrim, `${p} should be filtered`).toBe(base);
    }
  });

  it('still skips LSynth virtual segments + fraction primitives', () => {
    const base = voxelizeLDraw([brick('3001.dat')]).grid.countNonAir();
    for (const p of ['ls41.dat', '4-4cyli.dat', 'stud.dat']) {
      expect(voxelizeLDraw([brick('3001.dat'), brick(p, 0, 0, 200)]).grid.countNonAir()).toBe(base);
    }
  });
});

describe('voxelizeLDraw — degenerate input', () => {
  it('returns a 1×1×1 grid with 0 blocks for no bricks', () => {
    const r = voxelizeLDraw([]);
    expect(r.grid.countNonAir()).toBe(0);
    expect(r.brickCount).toBe(0);
  });

  it('reports unmapped colors via a colour with no mapping', () => {
    // 9999 is not in the LDraw colour table → gray fallback, flagged.
    const r = voxelizeLDraw([brick('3001.dat', 0, 0, 0, 9999)]);
    expect(r.unmappedColors).toContain(9999);
  });
});
