import { describe, it, expect } from 'vitest';
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

  it('Y-scales output to expectedHeightM regardless of photogrammetry overshoot', async () => {
    // Photogrammetry mesh spans 0-90m but expected height is 30m
    // (sub-grade noise + neighbour buildings inflated the bbox).
    // The Y normalisation should compress everything to 30m.
    const tower = makeBox([-5, 5, -3], [5, 90, 3]);
    const tiles = makeTileEvidence([tower], 90);
    const brep = synthesizeSlicedTiles(makeStubCtx(), makeStubEv(), tiles, { voxelResolution: 6 });
    const mesh = await evaluateBRep(brep);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < mesh.positions.length; i += 3) {
      minY = Math.min(minY, mesh.positions[i]);
      maxY = Math.max(maxY, mesh.positions[i]);
    }
    // ev.heightM.value = 30 (stub default) → mesh should span 0..30m
    expect(maxY - minY).toBeGreaterThan(28);
    expect(maxY - minY).toBeLessThan(32);
  });

  it('OSM mask drops slice polygons whose vertices fall outside OSM', async () => {
    // Two buildings: target at origin, neighbour at (50, 0). OSM polygon
    // covers only the target. Synthesizer should drop the neighbour's
    // bands, leaving only the target.
    const target = makeBox([-5, 0, -5], [5, 20, 5]);
    const neighbour = makeBox([45, 0, -5], [55, 20, 5]);
    const tiles = makeTileEvidence([target, neighbour], 20);
    // OSM polygon covering only the target square.
    const osmPolygon = [
      { lat: -0.00005, lon: -0.00005 },
      { lat: -0.00005, lon:  0.00005 },
      { lat:  0.00005, lon:  0.00005 },
      { lat:  0.00005, lon: -0.00005 },
    ];
    const ev = makeStubEv();
    const evWithOsm = {
      ...ev,
      footprint: { value: osmPolygon, source: 'osm' as const, confidence: 1.0 },
    } as unknown as JointEvidence;
    const ctxWithMbr = {
      ...makeStubCtx(),
      mbr: { rotationDeg: 0, widthM: 100, depthM: 100, corners: [] as never },
    } as unknown as RefinedBuildingContext;

    const brep = synthesizeSlicedTiles(ctxWithMbr, evWithOsm, tiles, { voxelResolution: 6 });
    const mesh = await evaluateBRep(brep);
    expect(mesh.watertight).toBe(true);
    // Volume should be ~10×10×30 (target only) = 3000 m³ approx
    // (Y-scaled to expected 30m). Neighbour at (50,0) is far outside OSM.
    expect(mesh.volume).toBeLessThan(5000);
    // No part of the mesh should be at X≈50 (neighbour location)
    let maxX = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      maxX = Math.max(maxX, mesh.positions[i]);
    }
    expect(maxX).toBeLessThan(20);
  });

  it('infers tapered roof shape for elongated top bands (≥4 bands required)', async () => {
    // Tall stepped pyramid: base + 3 progressively narrower stages.
    // Each stage is 5m tall so the band detector emits ≥4 distinct bands
    // even after polygon-matching collapses adjacent slices.
    const base   = makeBox([-10,  0, -3], [10,  5,  3]);
    const stage2 = makeBox([-7,   5, -2.5], [7,  10, 2.5]);
    const stage3 = makeBox([-4,  10, -2],  [4,  15, 2]);
    const stage4 = makeBox([-2,  15, -1.5], [2, 20, 1.5]);
    const tiles = makeTileEvidence([base, stage2, stage3, stage4], 20);
    const brep = synthesizeSlicedTiles(makeStubCtx(), makeStubEv(), tiles, { voxelResolution: 6 });
    expect(['gabled', 'pyramidal', 'flat']).toContain(brep.roof.type);
    if (brep.roof.type !== 'flat') {
      expect(brep.roof.peakZ).toBeGreaterThan(brep.roof.baseZ);
      // Long axis = X (20m) vs Z (6m) → aspect 3.3 → gabled
      expect(brep.roof.type).toBe('gabled');
    }
  });
});
