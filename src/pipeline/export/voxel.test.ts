import { describe, it, expect } from 'vitest';
import { exportVoxel, applyMaterialOverlay } from './voxel.js';
import { BlockGrid } from '../../schem/types.js';
import type { BuildingBRep, MaterialRef } from '../synthesis/brep.js';
import type { LocalPoint2D } from '../context/types.js';

function mat(block: string): MaterialRef {
  return { blockName: block, lab: [60, 0, 0] };
}

function boxBrep(heightM = 3): BuildingBRep {
  const SQ = 6;
  const poly: LocalPoint2D[] = [
    { x: -SQ / 2, z: -SQ / 2 },
    { x:  SQ / 2, z: -SQ / 2 },
    { x:  SQ / 2, z:  SQ / 2 },
    { x: -SQ / 2, z:  SQ / 2 },
  ];
  return {
    origin: { lat: 0, lng: 0 }, rotationDeg: 0,
    floors: [{ level: 0, elevationM: 0, thicknessM: 0.3, polygon: poly }],
    walls: [
      { level: 0, facadeEdge: 0, start: poly[0], end: poly[1],
        heightM, thicknessM: 0.3, material: 'wall' },
      { level: 0, facadeEdge: 1, start: poly[1], end: poly[2],
        heightM, thicknessM: 0.3, material: 'wall' },
      { level: 0, facadeEdge: 2, start: poly[2], end: poly[3],
        heightM, thicknessM: 0.3, material: 'wall' },
      { level: 0, facadeEdge: 3, start: poly[3], end: poly[0],
        heightM, thicknessM: 0.3, material: 'wall' },
    ],
    roof: {
      type: 'flat', baseZ: heightM + 0.3, peakZ: heightM + 0.8,
      pitchDeg: 0, polygon: poly, params: {},
    },
    details: [],
    materials: {
      wall: mat('minecraft:stone_bricks'),
      trim: mat('minecraft:smooth_stone'),
      roof: mat('minecraft:deepslate_tiles'),
      window: mat('minecraft:glass'),
    },
  };
}

describe('exportVoxel', () => {
  it('produces a non-empty BlockGrid from a small box BRep', async () => {
    const result = await exportVoxel(boxBrep());
    expect(result.blockCount).toBeGreaterThan(0);
    expect(result.grid.width).toBeGreaterThan(0);
    expect(result.grid.height).toBeGreaterThan(0);
    expect(result.grid.length).toBeGreaterThan(0);
    // 6×6 footprint at r=1, ~4m tall (walls 3m + roof 0.5m) → at least ~36 blocks wide
    // but solid voxelization fills the interior — should exceed the shell area
    expect(result.blockCount).toBeGreaterThan(10);
  }, 20_000);

  it('respects resolution — higher res produces more blocks', async () => {
    const r1 = await exportVoxel(boxBrep(), { resolution: 1 });
    const r2 = await exportVoxel(boxBrep(), { resolution: 2 });
    expect(r2.blockCount).toBeGreaterThan(r1.blockCount);
  }, 30_000);

  it('respects maxDimension cap', async () => {
    const result = await exportVoxel(boxBrep(20), { resolution: 4, maxDimension: 32 });
    expect(result.grid.width).toBeLessThanOrEqual(32);
    expect(result.grid.height).toBeLessThanOrEqual(32);
    expect(result.grid.length).toBeLessThanOrEqual(32);
  }, 30_000);

  it('surfaces wall and roof block names in result', async () => {
    const result = await exportVoxel(boxBrep());
    expect(result.wallBlock).toBe('minecraft:stone_bricks');
    expect(result.roofBlock).toBe('minecraft:deepslate_tiles');
  }, 20_000);
});

describe('applyMaterialOverlay window pass', () => {
  const AIR = 'minecraft:air';
  const WALL = 'minecraft:white_terracotta';
  const ROOF = 'minecraft:stone_bricks';
  const GLASS = 'minecraft:glass';

  /** Hollow box grid W×H×L with 1-block walls, solid roof/floor slab. */
  function hollowBox(W: number, H: number, L: number): BlockGrid {
    const g = new BlockGrid(W, H, L);
    for (let y = 0; y < H; y++) {
      for (let z = 0; z < L; z++) {
        for (let x = 0; x < W; x++) {
          const shell = x === 0 || x === W - 1 || z === 0 || z === L - 1 || y === 0 || y === H - 1;
          if (shell) g.set(x, y, z, WALL);
        }
      }
    }
    return g;
  }

  function countBlocks(g: BlockGrid, name: string): number {
    let n = 0;
    for (let y = 0; y < g.height; y++)
      for (let z = 0; z < g.length; z++)
        for (let x = 0; x < g.width; x++)
          if (g.get(x, y, z) === name) n++;
    return n;
  }

  /** Distinct y-rows that contain at least one glass voxel. */
  function glassRows(g: BlockGrid): number[] {
    const rows = new Set<number>();
    for (let y = 0; y < g.height; y++)
      for (let z = 0; z < g.length; z++)
        for (let x = 0; x < g.width; x++)
          if (g.get(x, y, z) === GLASS) { rows.add(y); break; }
    return [...rows].sort((a, b) => a - b);
  }

  it('residential 2-storey at 4 blocks/m gets exactly 2 window bands', () => {
    // 18m × 22m × 7m house at res 4 → 72×28×88 grid
    const g = hollowBox(72, 28, 88);
    applyMaterialOverlay(g, WALL, ROOF, GLASS, 4, { archType: 'residential', levels: 2 });
    const rows = glassRows(g);
    expect(rows.length).toBeGreaterThan(0);
    // Rows cluster into vertical bands: count gaps > 1 block to find bands.
    let bands = 1;
    for (let i = 1; i < rows.length; i++) if (rows[i] - rows[i - 1] > 1) bands++;
    expect(bands).toBe(2);
    // Window glass is a visible but not dominant fraction of the facade.
    const glass = countBlocks(g, GLASS);
    const wall = countBlocks(g, WALL);
    expect(glass / (glass + wall)).toBeGreaterThan(0.02);
    expect(glass / (glass + wall)).toBeLessThan(0.5);
  });

  it('dark commercial walls flip to curtain-wall (glass-dominant facade)', () => {
    // 30m × 30m × 40m tower at res 1 → 30×40×30
    const g = hollowBox(30, 40, 30);
    applyMaterialOverlay(g, WALL, ROOF, GLASS, 1, { archType: 'commercial', levels: 10, wallLabL: 20 });
    const glass = countBlocks(g, GLASS);
    const wall = countBlocks(g, WALL);
    expect(glass / (glass + wall)).toBeGreaterThan(0.3);
  });

  it('light commercial keeps punched windows, dark commercial reads glassier', () => {
    const punched = hollowBox(30, 40, 30);
    applyMaterialOverlay(punched, WALL, ROOF, GLASS, 1, { archType: 'commercial', levels: 10, wallLabL: 80 });
    const curtain = hollowBox(30, 40, 30);
    applyMaterialOverlay(curtain, WALL, ROOF, GLASS, 1, { archType: 'commercial', levels: 10, wallLabL: 20 });
    const share = (g: BlockGrid): number => {
      const gl = countBlocks(g, GLASS), wa = countBlocks(g, WALL);
      return gl / (gl + wa);
    };
    const punchedShare = share(punched);
    const curtainShare = share(curtain);
    expect(punchedShare).toBeGreaterThan(0.05);
    expect(punchedShare).toBeLessThan(0.4);
    expect(curtainShare).toBeGreaterThan(punchedShare + 0.15);
  });

  it('degenerate 2-block-tall grid places no windows', () => {
    const g = hollowBox(10, 2, 10);
    applyMaterialOverlay(g, WALL, ROOF, GLASS, 1, { archType: 'residential', levels: 1 });
    expect(countBlocks(g, GLASS)).toBe(0);
  });
});

describe('metre-scaled cornice and base bands', () => {
  const WALL = 'minecraft:smooth_sandstone';
  const ROOF = 'minecraft:stone_bricks';
  const GLASS = 'minecraft:glass';

  function hollowBox(W: number, H: number, L: number): BlockGrid {
    const g = new BlockGrid(W, H, L);
    for (let y = 0; y < H; y++)
      for (let z = 0; z < L; z++)
        for (let x = 0; x < W; x++)
          if (x === 0 || x === W - 1 || z === 0 || z === L - 1 || y === 0 || y === H - 1)
            g.set(x, y, z, WALL);
    return g;
  }

  /** Height of the contiguous run of `block` starting at y=0 on a side wall. */
  function bandFromFloor(g: BlockGrid, block: string): number {
    let n = 0;
    for (let y = 0; y < g.height; y++) {
      if (g.get(0, y, Math.floor(g.length / 2)) !== block) break;
      n++;
    }
    return n;
  }

  it('scales the base band with resolution, not block count', () => {
    // Same 40m building at 1 and 6 blocks/m must get the SAME METRIC base.
    // The old code emitted a flat 2 blocks either way — 0.33m at res 6.
    const lo = hollowBox(20, 40, 20);
    applyMaterialOverlay(lo, WALL, ROOF, GLASS, 1, { archType: 'commercial', levels: 10 });
    const hi = hollowBox(20, 240, 20);
    applyMaterialOverlay(hi, WALL, ROOF, GLASS, 6, { archType: 'commercial', levels: 10 });

    const loPlinth = bandFromFloor(lo, 'minecraft:smooth_stone');
    const hiPlinth = bandFromFloor(hi, 'minecraft:smooth_stone');
    expect(loPlinth).toBeGreaterThan(0);
    // Metres, not blocks: the high-res plinth is ~6x the block count.
    expect(hiPlinth / 6).toBeGreaterThan(loPlinth * 0.7);
    expect(hiPlinth / 6).toBeLessThan(loPlinth * 1.4);
  });

  it('gives a 73m tower a visible cornice at 6 blocks/m', () => {
    // Flatiron geometry: the old 3-block cornice was 0.5m — invisible.
    const g = hollowBox(30, 441, 30);
    applyMaterialOverlay(g, WALL, ROOF, GLASS, 6, { archType: 'commercial', levels: 22 });
    let trim = 0;
    for (let y = 0; y < g.height; y++)
      if (g.get(0, y, 15) === 'minecraft:chiseled_sandstone') trim++;
    expect(trim / 6).toBeGreaterThan(1.0);  // > 1 metre of cornice
    expect(trim / 6).toBeLessThan(3.0);     // but never a stripe
  });

  it('leaves a small house without a banded stripe', () => {
    // 5m cottage at 6 blocks/m: below the cornice threshold entirely.
    const g = hollowBox(40, 30, 40);
    applyMaterialOverlay(g, WALL, ROOF, GLASS, 6, { archType: 'residential', levels: 1 });
    let trim = 0;
    for (let y = 0; y < g.height; y++)
      if (g.get(0, y, 20) === 'minecraft:chiseled_sandstone') trim++;
    expect(trim).toBe(0);
  });
});

describe('eave-aware window band', () => {
  const AIR = 'minecraft:air';
  const WALL = 'minecraft:white_terracotta';
  const ROOF = 'minecraft:stone_bricks';
  const GLASS = 'minecraft:glass';

  it('keeps all windows below the eave on a pitched-roof massing', () => {
    // 24×24 walls up to y=12 (eave), then a solid stepped pyramid to y=22.
    const W = 24, L = 24, H = 23;
    const g = new BlockGrid(W, H, L);
    for (let y = 0; y < 12; y++)
      for (let z = 0; z < L; z++)
        for (let x = 0; x < W; x++)
          if (x === 0 || x === W - 1 || z === 0 || z === L - 1 || y === 0) g.set(x, y, z, WALL);
    for (let y = 12; y < H; y++) {
      const inset = y - 11; // pyramid: shrink 1 block per layer
      for (let z = inset; z < L - inset; z++)
        for (let x = inset; x < W - inset; x++)
          g.set(x, y, z, WALL);
    }
    applyMaterialOverlay(g, WALL, ROOF, GLASS, 2, { archType: 'residential', levels: 2 });
    let maxGlassY = -1;
    for (let y = 0; y < H; y++)
      for (let z = 0; z < L; z++)
        for (let x = 0; x < W; x++)
          if (g.get(x, y, z) === GLASS && y > maxGlassY) maxGlassY = y;
    expect(maxGlassY).toBeGreaterThan(0);   // windows exist
    expect(maxGlassY).toBeLessThan(12);     // none in the roof mass
  });
});
