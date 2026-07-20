import { describe, it, expect } from 'vitest';
import { analyseGridConnectivity, deriveDefects } from './defect.js';
import { BlockGrid } from '../../schem/types.js';
import type { ObjectiveResult } from './objective.js';
import type { CrossCheckResult } from './cross-check.js';

// A single 4×4×4 connected body; `types` distinct block names within it.
function gridSolid(types = 3): BlockGrid {
  const g = new BlockGrid(6, 6, 6);
  for (let y = 1; y <= 4; y++) {
    for (let z = 1; z <= 4; z++) {
      for (let x = 1; x <= 4; x++) g.set(x, y, z, 'minecraft:stone');
    }
  }
  if (types >= 2) g.set(2, 2, 2, 'minecraft:bricks');
  if (types >= 3) g.set(3, 3, 3, 'minecraft:glass');
  return g;
}

// The same body plus a detached 2×2×2 cluster across the grid.
function gridFloating(): BlockGrid {
  const g = new BlockGrid(12, 6, 12);
  for (let y = 1; y <= 4; y++) {
    for (let z = 1; z <= 4; z++) {
      for (let x = 1; x <= 4; x++) g.set(x, y, z, 'minecraft:stone');
    }
  }
  g.set(2, 2, 2, 'minecraft:bricks');
  g.set(3, 3, 3, 'minecraft:glass');
  for (let y = 1; y <= 2; y++) {
    for (let z = 9; z <= 10; z++) {
      for (let x = 9; x <= 10; x++) g.set(x, y, z, 'minecraft:stone');
    }
  }
  return g;
}

function obj(over: Partial<ObjectiveResult> = {}): ObjectiveResult {
  return {
    footprintIoU: 0.9, heightErr: 0.05, watertight: true, manifold: true,
    selfIntersect: 0, minWallThicknessMm: 2, voxelCount: 64, plinthWatertight: null,
    pass: true, failures: [], ...over,
  };
}

function cross(truncationSuspected = false): CrossCheckResult {
  return {
    chosenSource: 'tiles', chosenHeightM: 24, alternatives: [],
    maxDisagreement: truncationSuspected ? 2 : 0, truncationSuspected,
    ok: !truncationSuspected, warnings: truncationSuspected ? ['x'] : [],
  };
}

describe('analyseGridConnectivity', () => {
  it('counts one component + block types for a solid body', () => {
    const s = analyseGridConnectivity(gridSolid(3));
    expect(s.computed).toBe(true);
    expect(s.total).toBe(64);
    expect(s.components).toBe(1);
    expect(s.largestSize).toBe(64);
    expect(s.disconnectedRatio).toBe(0);
    expect(s.uniqueBlockTypes).toBe(3);
  });

  it('detects a detached cluster as a second component', () => {
    const s = analyseGridConnectivity(gridFloating());
    expect(s.components).toBe(2);
    expect(s.total).toBe(72);
    expect(s.largestSize).toBe(64);
    expect(s.disconnectedRatio).toBeCloseTo(8 / 72, 3);
  });

  it('reports zero for an empty grid', () => {
    const s = analyseGridConnectivity(new BlockGrid(4, 4, 4));
    expect(s.total).toBe(0);
    expect(s.components).toBe(0);
    expect(s.disconnectedRatio).toBe(0);
    expect(s.uniqueBlockTypes).toBe(0);
  });
});

describe('deriveDefects', () => {
  it('a clean build scores 10 with no penalties', () => {
    const r = deriveDefects(obj(), cross(false), gridSolid(3));
    expect(r.score).toBe(10);
    expect(r.penalties).toEqual([]);
    expect(r.defects.surface_detail_visible).toBe(true);
    expect(r.defects.proportions_correct).toBe(true);
  });

  it('flags height_truncated from the cross-check', () => {
    const r = deriveDefects(obj(), cross(true), gridSolid(3));
    expect(r.defects.height_truncated).toBe(true);
    expect(r.penalties).toContain('height_truncated');
    expect(r.score).toBe(9);
  });

  it('flags facade_holes from a non-watertight mesh', () => {
    const r = deriveDefects(obj({ watertight: false }), cross(false), gridSolid(3));
    expect(r.defects.facade_holes_visible).toBe(true);
    expect(r.score).toBe(9);
  });

  it('flags floating_artifacts from a detached cluster', () => {
    const r = deriveDefects(obj(), cross(false), gridFloating());
    expect(r.defects.floating_artifacts).toBe(true);
    expect(r.penalties).toContain('floating_artifacts');
    expect(r.score).toBe(9);
  });

  it('flags a uniform/monochrome surface', () => {
    const r = deriveDefects(obj(), cross(false), gridSolid(1));
    expect(r.defects.surface_detail_visible).toBe(false);
    expect(r.penalties).toContain('uniform_surface');
    expect(r.score).toBe(9);
  });

  it('flags footprint + proportions from a low IoU', () => {
    const r = deriveDefects(obj({ footprintIoU: 0.7 }), cross(false), gridSolid(3));
    expect(r.defects.footprint_wrong_shape).toBe(true);
    expect(r.defects.proportions_correct).toBe(false);
    expect(r.score).toBeCloseTo(9.4, 5);
  });
});

describe('facade coherence', () => {
  // 10×10×10 hollow-ish solid: enough side-exposed voxels (>200) to judge.
  function bigGrid(pick: (x: number, y: number, z: number) => string): BlockGrid {
    const g = new BlockGrid(12, 12, 12);
    for (let y = 1; y <= 10; y++) {
      for (let z = 1; z <= 10; z++) {
        for (let x = 1; x <= 10; x++) g.set(x, y, z, pick(x, y, z));
      }
    }
    return g;
  }

  it('a single-material facade is coherent (dominant share 1.0)', () => {
    const s = analyseGridConnectivity(bigGrid(() => 'minecraft:stone'));
    expect(s.facadeTotal).toBeGreaterThan(200);
    expect(s.facadeDominantShare).toBe(1);
    expect(s.facadeDominantState).toBe('minecraft:stone');
    const r = deriveDefects(obj(), null, bigGrid(() => 'minecraft:stone'));
    expect(r.defects.facade_incoherent).toBe(false);
    expect(r.penalties).not.toContain('facade_incoherent');
  });

  it('flags a fully-dithered facade (5-way alternation, max share 20%)', () => {
    // Mimics per-voxel recolor dither: 5 materials round-robin by position,
    // so no block exceeds ~20% — under the 25% coherence floor (the bad
    // sliced-flatiron measured 18%).
    const mats = [
      'minecraft:stone', 'minecraft:bricks', 'minecraft:tuff',
      'minecraft:andesite', 'minecraft:clay',
    ];
    const g = bigGrid((x, y, z) => mats[(x + y * 3 + z * 7) % mats.length]);
    const s = analyseGridConnectivity(g);
    expect(s.facadeDominantShare).toBeLessThan(0.25);
    const r = deriveDefects(obj(), null, g);
    expect(r.defects.facade_incoherent).toBe(true);
    expect(r.penalties).toContain('facade_incoherent');
  });

  it('exempts facades too small to judge', () => {
    // gridSolid's 4×4×4 body has ~64 side-exposed voxels — under the 200
    // floor, so even a dithered surface must not flag.
    const r = deriveDefects(obj(), null, gridSolid(3));
    expect(r.defects.facade_incoherent).toBe(false);
  });
});

describe('facade darkness (archetype-gated)', () => {
  function bigDark(block: string): BlockGrid {
    const g = new BlockGrid(12, 12, 12);
    for (let y = 1; y <= 10; y++)
      for (let z = 1; z <= 10; z++)
        for (let x = 1; x <= 10; x++) g.set(x, y, z, block);
    return g;
  }
  it('flags a near-black residential facade', () => {
    // deepslate family luma ≈ 80 — well under the 110 residential floor.
    const g = bigDark('minecraft:polished_deepslate');
    const r = deriveDefects(obj(), null, g, { archType: 'residential' });
    expect(r.defects.facade_implausibly_dark).toBe(true);
    expect(r.penalties).toContain('facade_implausibly_dark');
  });
  it('exempts commercial (dark curtain wall is plausible)', () => {
    const g = bigDark('minecraft:polished_deepslate');
    const r = deriveDefects(obj(), null, g, { archType: 'commercial' });
    expect(r.defects.facade_implausibly_dark).toBe(false);
  });
  it('no flag without archType (legacy callers)', () => {
    const g = bigDark('minecraft:polished_deepslate');
    const r = deriveDefects(obj(), null, g);
    expect(r.defects.facade_implausibly_dark).toBe(false);
  });
  it('bright residential facade passes', () => {
    const g = bigDark('minecraft:white_terracotta');
    const r = deriveDefects(obj(), null, g, { archType: 'residential' });
    expect(r.defects.facade_implausibly_dark).toBe(false);
  });
});
