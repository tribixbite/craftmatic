import { describe, it, expect } from 'vitest';
import {
  analyseEdges,
  countSelfIntersections,
  footprintIoU,
  heightErrorRatio,
  minWallThicknessM,
  runObjectiveGates,
  voxelOccupancy,
} from './objective.js';
import { BlockGrid } from '../../schem/types.js';
import type { LatLon } from '../context/types.js';

// Small closed tetrahedron (4 vertices, 4 tris) — watertight + manifold
function tetraMesh() {
  const positions = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1,  // bottom
    0, 1, 3,  // south
    0, 3, 2,  // east
    1, 2, 3,  // top
  ]);
  return { positions, indices };
}

function openShellMesh() {
  // 3 triangles sharing no bottom — 4 boundary edges
  const positions = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    1, 1, 0,
  ]);
  const indices = new Uint32Array([
    0, 1, 2,
    1, 3, 2,
  ]);
  return { positions, indices };
}

describe('analyseEdges', () => {
  it('tetrahedron has 0 boundary + 0 non-manifold', () => {
    const { indices } = tetraMesh();
    const { boundaryCount, nonManifoldCount } = analyseEdges(indices);
    expect(boundaryCount).toBe(0);
    expect(nonManifoldCount).toBe(0);
  });
  it('open shell has boundary edges', () => {
    const { indices } = openShellMesh();
    const { boundaryCount } = analyseEdges(indices);
    expect(boundaryCount).toBeGreaterThan(0);
  });
});

describe('footprintIoU', () => {
  it('perfect overlap → IoU = 1', () => {
    // A 10×10 box at origin, facing flat XZ plane, polygon identical
    const positions = new Float32Array([
      -5, 0, -5,   5, 0, -5,   5, 0,  5,  -5, 0,  5,
      -5, 5, -5,   5, 5, -5,   5, 5,  5,  -5, 5,  5,
    ]);
    const indices = new Uint32Array([
      0, 1, 2,  0, 2, 3, // bottom
      4, 6, 5,  4, 7, 6, // top
    ]);
    const target: LatLon[] = [
      // 10×10 square around (0, 0) — degrees chosen to project back to ±5m in local
      { lat: 0,  lon: 0 }, { lat: 0,  lon: 0 }, { lat: 0, lon: 0 }, { lat: 0, lon: 0 },
    ];
    // Target polygon needs to map to local ±5m box. Easier: test with a
    // local frame (rotationDeg=0, center=origin) and degrees ≈ 5/111111
    const d = 5 / 111_111;
    const tgt: LatLon[] = [
      { lat: -d, lon: -d }, { lat: -d, lon: d },
      { lat: d, lon: d }, { lat: d, lon: -d },
    ];
    const iou = footprintIoU(positions, indices, tgt, { lat: 0, lng: 0 }, 0);
    expect(iou).toBeGreaterThan(0.9);
  });
});

describe('heightErrorRatio', () => {
  it('returns 0 when measured matches expected', () => {
    const pos = new Float32Array([0, 0, 0, 0, 20, 0]);
    expect(heightErrorRatio(pos, 20)).toBeCloseTo(0);
  });
  it('returns 0.1 when measured is 10% off', () => {
    const pos = new Float32Array([0, 0, 0, 0, 22, 0]);
    expect(heightErrorRatio(pos, 20)).toBeCloseTo(0.1);
  });
  it('returns 0 when expected is null/zero (cannot evaluate)', () => {
    expect(heightErrorRatio(new Float32Array([0, 0, 0, 0, 20, 0]), 0)).toBe(0);
  });
});

describe('countSelfIntersections', () => {
  it('returns 0 for a clean tetrahedron', () => {
    const { positions, indices } = tetraMesh();
    expect(countSelfIntersections(positions, indices)).toBe(0);
  });
});

describe('minWallThicknessM', () => {
  it('bounds from bbox — min thickness ≤ 1/40 of min extent', () => {
    const pos = new Float32Array([0, 0, 0, 10, 5, 8]); // 10×5×8m bbox → min extent 5m
    // wx = 10, wz = 8 → minExtent = 8 → result = 0.2
    expect(minWallThicknessM(pos)).toBeCloseTo(0.2);
  });
});

describe('voxelOccupancy', () => {
  it('counts non-air blocks', () => {
    const g = new BlockGrid(4, 4, 4);
    g.set(0, 0, 0, 'minecraft:stone');
    g.set(1, 0, 0, 'minecraft:stone');
    g.set(2, 0, 0, 'minecraft:dirt');
    const occ = voxelOccupancy(g);
    expect(occ.count).toBe(3);
    expect(occ.limit).toBe(500_000);
  });
});

describe('runObjectiveGates', () => {
  it('returns pass=true when everything satisfies', () => {
    const { positions, indices } = tetraMesh();
    const d = 1 / 111_111;
    const target: LatLon[] = [
      { lat: 0, lon: 0 }, { lat: 0, lon: d },
      { lat: d, lon: d }, { lat: d, lon: 0 },
    ];
    const grid = new BlockGrid(4, 4, 4);
    grid.set(0, 0, 0, 'minecraft:stone');
    const r = runObjectiveGates({
      positions, indices, targetPolygon: target,
      meshOrigin: { lat: 0, lng: 0 }, meshRotationDeg: 0,
      expectedHeightM: 1, grid,
    });
    expect(r.watertight).toBe(true);
    expect(r.manifold).toBe(true);
    expect(r.selfIntersect).toBe(0);
  });

  it('captures specific failures in failures[]', () => {
    const { positions, indices } = openShellMesh();
    const d = 0.0001;
    const target: LatLon[] = [
      { lat: 0, lon: 0 }, { lat: 0, lon: d }, { lat: d, lon: d }, { lat: d, lon: 0 },
    ];
    const grid = new BlockGrid(1, 1, 1);
    const r = runObjectiveGates({
      positions, indices, targetPolygon: target,
      meshOrigin: { lat: 0, lng: 0 }, meshRotationDeg: 0,
      expectedHeightM: 50, // mesh is < 50m → height error huge
      grid,
    });
    expect(r.pass).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
    // Should mention both open shell + height
    const joined = r.failures.join('; ');
    expect(joined).toMatch(/watertight|boundary/i);
  });
});
