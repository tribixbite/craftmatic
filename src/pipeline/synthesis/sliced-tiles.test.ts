import { describe, it, expect } from 'bun:test';
import { synthesizeSlicedTiles } from './sliced-tiles.js';
import { evaluateBRep } from './brep.js';
import type { TileEvidence } from '../capture/types.js';
import type { JointEvidence } from '../fusion/types.js';
import type { RefinedBuildingContext } from '../context/types.js';

// ─── Synthetic mesh helpers ─────────────────────────────────────────────────

function makeBox(min: [number, number, number], max: [number, number, number]) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return {
    positions: new Float32Array([
      x0, y0, z0,  x1, y0, z0,  x1, y0, z1,  x0, y0, z1,
      x0, y1, z0,  x1, y1, z0,  x1, y1, z1,  x0, y1, z1,
    ]),
    indices: new Uint32Array([
      0, 2, 1,  0, 3, 2, 4, 5, 6,  4, 6, 7,
      0, 1, 5,  0, 5, 4, 3, 7, 6,  3, 6, 2,
      0, 4, 7,  0, 7, 3, 1, 2, 6,  1, 6, 5,
    ]),
  };
}

function makeStubCtx(): RefinedBuildingContext {
  return {
    address: 'test',
    formattedAddress: 'test',
    placeId: null,
    center: { lat: 0, lng: 0 },
    archType: 'commercial',
    size: 'mid-rise',
    shape: 'rectilinear',
    polygon: null,
    polygonSource: null,
    mbr: { rotationDeg: 0, widthM: 30, depthM: 30, corners: [] as never },
    rawOsm: null,
    rawSolar: null,
    rawSmarty: null,
    siblings: [],
    __refined: true,
  } as unknown as RefinedBuildingContext;
}

function makeStubEv(): JointEvidence {
  const provenance = { value: null, source: 'inferred' as const, confidence: 0.5 };
  return {
    footprint: { value: [], source: 'inferred', confidence: 0.5 },
    heightM: { value: 30, source: 'inferred', confidence: 0.5 },
    levels: { value: 10, source: 'inferred', confidence: 0.5 },
    wallPalette: { value: [[60, 5, 10]] as never, source: 'inferred', confidence: 0.5 },
    roofPalette: { value: [[40, 0, 5]] as never, source: 'inferred', confidence: 0.5 },
    accentPalette: provenance as never,
    trimPalette: provenance as never,
    archType: { value: 'commercial', source: 'inferred', confidence: 0.5 },
    roofType: { value: 'flat', source: 'inferred', confidence: 0.5 },
    windowGrid: [null, null, null, null] as never,
    cornice: { value: false, source: 'inferred', confidence: 0.5 },
    entry: { value: { edge: 0, offsetAlongEdge: 0.5 }, source: 'inferred', confidence: 0.5 },
    occlusion: { value: { trees: 0, buildings: 0, poles: 0 }, source: 'inferred', confidence: 0.5 },
    treeHints: provenance as never,
    roadHints: provenance as never,
  } as unknown as JointEvidence;
}

function makeTileEvidence(meshes: ReadonlyArray<{ positions: Float32Array; indices: Uint32Array }>, height: number): TileEvidence {
  // Compute combined bbox
  let minY = Infinity, maxY = -Infinity;
  for (const m of meshes) {
    for (let i = 1; i < m.positions.length; i += 3) {
      minY = Math.min(minY, m.positions[i]);
      maxY = Math.max(maxY, m.positions[i]);
    }
  }
  return {
    glbPath: null,
    glbBytes: new ArrayBuffer(0),
    heightmap: new Float32Array(0),
    heightmapWidth: 0,
    heightmapLength: 0,
    measuredBbox: {
      min: { x: -50, y: minY, z: -50 },
      max: { x:  50, y: maxY, z:  50 },
    },
    truncated: false,
    meshCount: meshes.length,
    noCoverage: false,
    meshes,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('synthesizeSlicedTiles + evaluateBRep', () => {
  it('produces a watertight prism for a uniform box', async () => {
    const box = makeBox([-5, 0, -3], [5, 30, 3]);
    const tiles = makeTileEvidence([box], 30);
    const brep = synthesizeSlicedTiles(makeStubCtx(), makeStubEv(), tiles, { voxelResolution: 6 });
    expect(brep.bandedSilhouettes).toBeDefined();
    expect(brep.bandedSilhouettes!.length).toBeGreaterThan(0);
    const mesh = await evaluateBRep(brep);
    expect(mesh.watertight).toBe(true);
    expect(mesh.positions.length).toBeGreaterThan(0);
    // Volume close to 10 × 30 × 6 = 1800 m³
    expect(mesh.volume).toBeGreaterThan(1500);
    expect(mesh.volume).toBeLessThan(2100);
  });

  it('twin-tower input keeps the closest-to-origin tower under maxPolysPerSlice=1 default', async () => {
    // Pennzoil-style: shared base 0-5m, then two trapezoid towers above.
    // Default `maxPolysPerSlice: 1` keeps just the building closest to
    // origin per slice — for this synthetic input the two towers are
    // equidistant so one is dropped. Volume is (30×10×5 base) + (13×10×25
    // single tower) = 1500 + 3250 = 4750 m³, not the full 8000 m³.
    const base = makeBox([-15, 0, -5], [15, 5, 5]);
    const towerA = makeBox([-15, 5, -5], [-2, 30, 5]);
    const towerB = makeBox([2, 5, -5], [15, 30, 5]);
    const tiles = makeTileEvidence([base, towerA, towerB], 30);
    const brep = synthesizeSlicedTiles(makeStubCtx(), makeStubEv(), tiles, { voxelResolution: 6 });
    expect(brep.bandedSilhouettes).toBeDefined();
    expect(brep.bandedSilhouettes!.length).toBeGreaterThanOrEqual(2);
    const mesh = await evaluateBRep(brep);
    expect(mesh.watertight).toBe(true);
    // Base + one tower (the closer one)
    expect(mesh.volume).toBeGreaterThan(4000);
    expect(mesh.volume).toBeLessThan(6000);
  });
});
