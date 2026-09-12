/**
 * Minecraft-export resolution planning (S4) — offline, deterministic.
 *
 * The load-bearing property: `auto` must reproduce the SHIPPED 2026-08-23
 * ladder exactly (finest cubic cell from [4,5,8,10,20] that fits
 * max(w,l)≤640, h≤320, ≤30M cells). The 21063 reference-export sha256 gate
 * depends on it, so the historical algorithm is re-implemented here in the
 * test as an independent oracle rather than imported.
 */

import { describe, it, expect } from 'vitest';
import {
  planResolution, describePlan, capViolation, RESOLUTION_CAPS, AUTO_CELL_LADDER,
  RESOLUTION_OPTIONS, DEFAULT_SCHEM_SETTINGS, type SpanLDU,
} from '../web/src/engine/schem-settings.js';
import { getBlockProfile, BLOCK_PROFILES, DEFAULT_PROFILE_ID } from '../web/src/engine/block-profiles.js';
import { studioColorToBlock } from '../web/src/engine/studio-colors.js';
import { ldrawColorToBlock } from '../web/src/engine/ldraw-colors.js';

/** The pre-S4 inline ladder, verbatim from lego.ts before the extraction. */
function legacyAutoCell(span: SpanLDU): number {
  let cellLDU = 20;
  for (const c of [4, 5, 8, 10, 20]) {
    const w = span.x / c, h = span.y / c, l = span.z / c;
    if (Math.max(w, l) <= 640 && h <= 320 && w * h * l <= 30_000_000) { cellLDU = c; break; }
  }
  return cellLDU;
}

describe('planResolution — auto', () => {
  it('matches the legacy ladder across a range of model sizes', () => {
    const spans: SpanLDU[] = [
      { x: 80, y: 80, z: 80 },            // a single brick
      { x: 520, y: 780, z: 1160 },        // 21063-ish
      { x: 2000, y: 900, z: 2000 },       // big display set
      { x: 5000, y: 1200, z: 5000 },      // UCS-class
      { x: 20000, y: 4000, z: 20000 },    // absurd
    ];
    for (const span of spans) {
      expect(planResolution(span, 'auto').cellLDU).toBe(legacyAutoCell(span));
    }
  });

  it('is the default setting', () => {
    // `shapes` defaults ON: the block-shape pass only refines cells that are
    // already solid, so the worst case is the previous all-cubes output.
    expect(DEFAULT_SCHEM_SETTINGS).toEqual({
      resolution: 'auto', profile: 'default', lightFill: false, shapes: true,
      lightCoverage: 'covered', lightStyle: 'profile', lightSpacing: 6, vehicleFacing: 'auto',
      detailMaterials: false,
    });
  });

  it('reports cells-per-stud and approximate dims', () => {
    const plan = planResolution({ x: 400, y: 200, z: 800 }, 'auto');
    expect(plan.cellLDU).toBe(4);
    expect(plan.cellsPerStud).toBe(5);
    expect(plan.dims).toEqual({ width: 100, height: 50, length: 200 });
    expect(plan.cells).toBe(100 * 50 * 200);
    expect(plan.requestedHonored).toBe(true);
  });

  it('falls back to the coarsest cell when nothing fits, flagged overCap', () => {
    const huge: SpanLDU = { x: 100_000, y: 100_000, z: 100_000 };
    const plan = planResolution(huge, 'auto');
    expect(plan.cellLDU).toBe(AUTO_CELL_LADDER[AUTO_CELL_LADDER.length - 1]);
    expect(plan.overCap).toBe(true);
  });
});

describe('planResolution — explicit override', () => {
  const span: SpanLDU = { x: 400, y: 200, z: 800 };

  it('honours 1 block per stud', () => {
    const plan = planResolution(span, '20');
    expect(plan.cellLDU).toBe(20);
    expect(plan.cellsPerStud).toBe(1);
    expect(plan.dims).toEqual({ width: 20, height: 10, length: 40 });
    expect(plan.requestedHonored).toBe(true);
  });

  it('honours 2.5 blocks per stud', () => {
    const plan = planResolution(span, '8');
    expect(plan.cellLDU).toBe(8);
    expect(plan.cellsPerStud).toBe(2.5);
    expect(plan.requestedHonored).toBe(true);
  });

  it('COARSENS a too-fine request back to the auto pick and says so', () => {
    // 5 blocks/stud on a 4000-LDU-wide model = 1000 cells wide > the 640 cap.
    const big: SpanLDU = { x: 4000, y: 800, z: 4000 };
    expect(legacyAutoCell(big)).toBe(8);
    const plan = planResolution(big, '4');
    expect(plan.requestedHonored).toBe(false);
    expect(plan.requestedCellLDU).toBe(4);
    expect(plan.cellLDU).toBe(8);
    expect(plan.refusedBy).toBe('horizontal');
    expect(describePlan(plan)).toMatch(/would exceed the 640-block width limit/);
  });

  it('enforces every cap, not just the horizontal one', () => {
    // Tall and thin: 5 blocks/stud would be 800 cells high > the 320 cap.
    const tall: SpanLDU = { x: 200, y: 3200, z: 200 };
    const plan = planResolution(tall, '4');
    expect(plan.requestedHonored).toBe(false);
    expect(plan.dims.height).toBeLessThanOrEqual(RESOLUTION_CAPS.maxHeight);
  });

  it('names the cap that actually refused, not always the width one', () => {
    // Height is the binding cap here; saying "width" sends the user to resize
    // the wrong axis (21063 at 10×/stud is exactly this case).
    const tall: SpanLDU = { x: 200, y: 3200, z: 200 };
    const plan = planResolution(tall, '4');
    expect(plan.refusedBy).toBe('height');
    expect(describePlan(plan)).toMatch(/height limit/);
    expect(capViolation(tall, 4)).toBe('height');
    expect(capViolation(tall, 20)).toBe(null);
  });

  it('offers 10 blocks per stud, and honours it when it fits', () => {
    const opt = RESOLUTION_OPTIONS.find(o => o.value === '2');
    expect(opt?.cellLDU).toBe(2);
    const small: SpanLDU = { x: 184, y: 153, z: 261 };   // 5969-1, measured
    const plan = planResolution(small, '2');
    expect(plan.requestedHonored).toBe(true);
    expect(plan.cellLDU).toBe(2);
    expect(plan.cellsPerStud).toBe(10);
  });

  it('keeps 10 blocks per stud OUT of the auto ladder', () => {
    // Opt-in only: it is ~7× the cells of the 5×/stud tier, so putting it in
    // the ladder would silently inflate every small export (and move the
    // 21063 reference hash).
    expect(AUTO_CELL_LADDER).not.toContain(2);
    const small: SpanLDU = { x: 184, y: 153, z: 261 };
    expect(planResolution(small, 'auto').cellLDU).toBe(4);
  });

  it('refuses 10 blocks per stud for a model that cannot fit it', () => {
    const big: SpanLDU = { x: 580, y: 824, z: 1220 };    // 21063, measured
    const plan = planResolution(big, '2');
    expect(plan.requestedHonored).toBe(false);
    expect(plan.refusedBy).toBe('height');
    expect(plan.cellLDU).toBe(planResolution(big, 'auto').cellLDU);
  });

  it('describePlan reports the block dims a user will get', () => {
    expect(describePlan(planResolution(span, '20'))).toContain('20×10×40');
  });
});

describe('block-mapping profiles', () => {
  it('ships only real profiles (distinct tables, not fake entries)', () => {
    // The rule the seam was built with (block-profiles.ts header): an entry
    // must be a genuinely different mapping table, never a re-point at the
    // default. Two ship today — `default` (concrete/glass) and `textured`
    // (OKLab onto slab-capable stone/wood families, slice 4).
    expect(BLOCK_PROFILES.length).toBeGreaterThanOrEqual(1);
    expect(BLOCK_PROFILES[0]!.id).toBe(DEFAULT_PROFILE_ID);
    expect(new Set(BLOCK_PROFILES.map(p => p.id)).size).toBe(BLOCK_PROFILES.length);
    // No two profiles may resolve every colour identically.
    const resolved = BLOCK_PROFILES.map(p => {
      const fn = p.colorFn('ldraw') ?? ldrawColorToBlock;
      return [0, 15, 19, 71, 72, 4].map(fn).join('|');
    });
    expect(new Set(resolved).size).toBe(BLOCK_PROFILES.length);
  });

  it('resolves BL colour ids through the Studio table and LDraw through the engine default', () => {
    const p = getBlockProfile('default');
    // `undefined` means "engine default table" — the voxelizers use a null
    // colorFn to decide whether unmapped ids are worth reporting, so passing
    // ldrawColorToBlock explicitly would NOT be a no-op.
    expect(p.colorFn('ldraw')).toBeUndefined();
    expect(p.colorFn('bl')).toBe(studioColorToBlock);
  });

  it('falls back to the default profile for an unknown id', () => {
    expect(getBlockProfile('nope').id).toBe(DEFAULT_PROFILE_ID);
    expect(getBlockProfile(undefined).id).toBe(DEFAULT_PROFILE_ID);
  });
});
