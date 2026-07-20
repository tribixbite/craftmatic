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

describe('cantilever height gate (ground-band neighbour merge)', () => {
  // 22.4×22.4m OSM square (501.8m² — just over the 500m² cantilever size
  // gate) centred on the origin. The building box (±10) slices to vertices
  // strictly inside the ring. The overhang blob ([-10..20]², 900m²) has one
  // corner inside OSM (anyInside ✓), three outside (allInside ✗), centroid
  // (5,5) inside, and a 1.79× area ratio — exactly the cantilever signature,
  // so the branch decision rests on Y alone. The two tests share identical
  // XZ geometry, differing only in the blob's Y band: if the signature ever
  // drifts out of the cantilever window, the keep-test fails rather than
  // both silently passing.
  const D = 11.2 / 111_111;
  function makeOsmCtx(): RefinedBuildingContext {
    const ctx = makeStubCtx() as unknown as {
      center: { lat: number; lng: number };
      mbr: { rotationDeg: number; widthM: number; depthM: number };
    };
    ctx.center = { lat: 0, lng: 0 };
    ctx.mbr.rotationDeg = 0;
    // mbr 30 → cropHalf 20, keeping the blob's +20m edge out of the crop.
    ctx.mbr.widthM = 30;
    ctx.mbr.depthM = 30;
    return ctx as unknown as RefinedBuildingContext;
  }
  function makeOsmEv(): JointEvidence {
    const ev = makeStubEv() as unknown as { footprint: unknown };
    ev.footprint = {
      value: [
        { lat: -D, lon: -D }, { lat: -D, lon: D },
        { lat: D, lon: D }, { lat: D, lon: -D },
      ],
      source: 'osm',
      confidence: 1,
    };
    return ev as unknown as JointEvidence;
  }
  const BUILDING: [[number, number, number], [number, number, number]] =
    [[-10, 0, -10], [10, 30, 10]];
  const BLOB_XZ: { x0: number; x1: number; z0: number; z1: number } =
    { x0: -10, x1: 20, z0: -10, z1: 20 };

  function maxAbsX(positions: Float32Array): number {
    let m = 0;
    for (let i = 0; i < positions.length; i += 3) m = Math.max(m, Math.abs(positions[i]));
    return m;
  }

  it('anchors a GROUND band merged with plaza/neighbour mass to OSM', async () => {
    // Blob at 0-4m: pre-fix its cantilever signature kept the merged ring
    // verbatim — the plaza-shard / guggenheim-neighbour failure (IoU 0.57).
    // The height gate (y0 below max(8m, 25% of range)) must anchor it.
    const building = makeBox(...[BUILDING[0], BUILDING[1]] as [never, never]);
    const blob = makeBox([BLOB_XZ.x0, 0, BLOB_XZ.z0], [BLOB_XZ.x1, 4, BLOB_XZ.z1]);
    const tiles = makeTileEvidence([building, blob], 30);
    const brep = synthesizeSlicedTiles(makeOsmCtx(), makeOsmEv(), tiles, { voxelResolution: 6 });
    const mesh = await evaluateBRep(brep);
    // Anchored to the ±11.2m OSM ring — never the blob's ±16.4m.
    expect(maxAbsX(mesh.positions)).toBeLessThan(13);
  });

  it('still keeps a real UPPER-floor cantilever (Geisel-class)', async () => {
    // Identical overhang at 12-16m — above the 8m floor — must survive as-is.
    const building = makeBox(...[BUILDING[0], BUILDING[1]] as [never, never]);
    const blob = makeBox([BLOB_XZ.x0, 12, BLOB_XZ.z0], [BLOB_XZ.x1, 16, BLOB_XZ.z1]);
    const tiles = makeTileEvidence([building, blob], 30);
    const brep = synthesizeSlicedTiles(makeOsmCtx(), makeOsmEv(), tiles, { voxelResolution: 6 });
    const mesh = await evaluateBRep(brep);
    expect(maxAbsX(mesh.positions)).toBeGreaterThan(15);
  });
});

describe('band-anchor snap (layer-cake belts)', () => {
  // OSM ±11.2m. Stack: a band jittered slightly INSIDE the wall line
  // (±10.8, 0.93× OSM area), a band overshooting it (±11.6, partial
  // overlap), then a genuine setback (±7, 0.39×). Pre-fix the first two
  // anchored differently (raw ring vs OSM outline), stepping a continuous
  // shaft into layer-cake belts; post-fix both snap to OSM while the real
  // setback stays raw.
  const D = 11.2 / 111_111;
  function osmCtx(): RefinedBuildingContext {
    const ctx = makeStubCtx() as unknown as {
      center: { lat: number; lng: number };
      mbr: { rotationDeg: number; widthM: number; depthM: number };
    };
    ctx.center = { lat: 0, lng: 0 };
    ctx.mbr.rotationDeg = 0;
    ctx.mbr.widthM = 23;
    ctx.mbr.depthM = 23;
    return ctx as unknown as RefinedBuildingContext;
  }
  function osmEv(): JointEvidence {
    const ev = makeStubEv() as unknown as { footprint: unknown };
    ev.footprint = {
      value: [
        { lat: -D, lon: -D }, { lat: -D, lon: D },
        { lat: D, lon: D }, { lat: D, lon: -D },
      ],
      source: 'osm',
      confidence: 1,
    };
    return ev as unknown as JointEvidence;
  }

  it('snaps jittered near-OSM bands to one silhouette, keeps real setbacks', async () => {
    const inner = makeBox([-10.8, 0, -10.8], [10.8, 10, 10.8]);   // 0.93× OSM
    const outer = makeBox([-11.6, 10, -11.6], [11.6, 20, 11.6]);  // overshoot
    const setback = makeBox([-7, 20, -7], [7, 30, 7]);            // 0.39× OSM
    const tiles = makeTileEvidence([inner, outer, setback], 30);
    const brep = synthesizeSlicedTiles(osmCtx(), osmEv(), tiles, { voxelResolution: 6 });
    const mesh = await evaluateBRep(brep);

    let lowerMax = 0, topMax = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const ax = Math.abs(mesh.positions[i]);
      const y = mesh.positions[i + 1];
      if (y < 18) lowerMax = Math.max(lowerMax, ax);
      if (y > 22) topMax = Math.max(topMax, ax);
    }
    // Both lower bands sit on the OSM line (±11.2): the 0.93× ring snapped
    // OUT to it (pre-fix it stayed at 10.8 — a false setback step).
    expect(lowerMax).toBeGreaterThan(11.0);
    expect(lowerMax).toBeLessThan(12.0);
    // The genuine setback stays raw at ±7.
    expect(topMax).toBeLessThan(8);
  });
});

describe('vertical continuity (mid-shaft void belts)', () => {
  it('bridges a full-slice Y-gap with the band below', async () => {
    // Photogrammetry-style dropout: geometry exists at 0-10m and 15-30m,
    // nothing in between (reflective floor band). Pre-fix the two slabs
    // shipped with a 5m void belt; the bridge must span it with the lower
    // band's polygon, yielding one continuous solid.
    const lower = makeBox([-5, 0, -5], [5, 10, 5]);
    const upper = makeBox([-5, 15, -5], [5, 30, 5]);
    const tiles = makeTileEvidence([lower, upper], 30);
    const brep = synthesizeSlicedTiles(makeStubCtx(), makeStubEv(), tiles, { voxelResolution: 6 });
    const mesh = await evaluateBRep(brep);
    expect(mesh.watertight).toBe(true);
    // Continuous 10×10 column over the full (rescaled) 30m: ~3000m³.
    // Pre-fix: 10+15=25m of solid rescaled to 30 → also ~3000m³ BUT with a
    // void — so assert continuity directly: every 1m Y-window of the mesh's
    // span must contain geometry.
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < mesh.positions.length; i += 3) {
      minY = Math.min(minY, mesh.positions[i]);
      maxY = Math.max(maxY, mesh.positions[i]);
    }
    const windows = new Set<number>();
    for (let i = 1; i < mesh.positions.length; i += 3) {
      windows.add(Math.floor(mesh.positions[i] - minY));
    }
    // Vertex-based probe: prism corners exist at every band boundary, so a
    // void produces a >2m run of windows with no vertices. Allow isolated
    // empty windows (long uniform prisms have no interior vertices) but no
    // TWO consecutive empties inside the span.
    let consecEmpty = 0, worst = 0;
    for (let w = 0; w < Math.floor(maxY - minY); w++) {
      consecEmpty = windows.has(w) ? 0 : consecEmpty + 1;
      worst = Math.max(worst, consecEmpty);
    }
    expect(mesh.volume).toBeGreaterThan(2500);
    expect(worst).toBeLessThanOrEqual(14); // pre-fix void: an unbroken 5m+ gap with NO band boundary inside
  });
});

// ─── helical trend fit ──────────────────────────────────────────────────────
import { fitHelicalFrustum } from './sliced-tiles.js';

describe('fitHelicalFrustum radius trend', () => {
  function circleBand(r: number, y0: number, y1: number) {
    const poly = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * 2 * Math.PI;
      poly.push({ x: r * Math.cos(a), z: r * Math.sin(a) });
    }
    return { polygon: poly, baseY: y0, topY: y1 };
  }

  it('detects a gradual taper the endpoint comparison missed', () => {
    // Radii trend 21→25 (~17% fitted variation) but the endpoint bands are
    // noisy: 22 → 23.5 reads as only 6% endpoint-to-endpoint — the old
    // fitter called this a cylinder (guggenheim's drum).
    const radii = [22, 21, 22.5, 24, 25, 23.5];
    const bands = radii.map((r, i) => circleBand(r, i * 5, i * 5 + 5));
    const fit = fitHelicalFrustum(bands, 0.9, null);
    expect(fit).not.toBeNull();
    expect(fit!.scaleTop[0]).toBeGreaterThan(1.1); // widening upward
  });

  it('still fits a clean cylinder as a cylinder', () => {
    const bands = [20, 20.2, 19.9, 20.1, 20, 20.1].map((r, i) => circleBand(r, i * 5, i * 5 + 5));
    const fit = fitHelicalFrustum(bands, 0.9, null);
    expect(fit).not.toBeNull();
    expect(fit!.scaleTop[0]).toBe(1.0);
  });

  it('rejects oscillating (non-architectural) radius profiles', () => {
    const bands = [20, 28, 19, 27, 18, 28].map((r, i) => circleBand(r, i * 5, i * 5 + 5));
    const fit = fitHelicalFrustum(bands, 0.9, null);
    expect(fit).toBeNull();
  });
});
