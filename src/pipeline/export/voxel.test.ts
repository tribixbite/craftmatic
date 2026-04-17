import { describe, it, expect } from 'vitest';
import { exportVoxel } from './voxel.js';
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
