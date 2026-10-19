import { describe, it, expect } from 'vitest';
import { routeSynthesis, synthesize } from './router.js';
import { evaluateBRep } from './brep.js';
import type { RefinedBuildingContext, BuildingContext, LatLon } from '../context/types.js';
import type { JointEvidence } from '../fusion/types.js';
import type { TileEvidence } from '../capture/types.js';

function makeCtx(overrides: Partial<BuildingContext> = {}): RefinedBuildingContext {
  const base: BuildingContext = {
    center: { lat: 40.7414, lng: -73.9895 },
    polygon: [
      { lat: 40.7413, lon: -73.9897 }, { lat: 40.7413, lon: -73.9894 },
      { lat: 40.7415, lon: -73.9894 }, { lat: 40.7415, lon: -73.9897 },
    ],
    polygonSource: 'osm',
    mbr: {
      rotationDeg: 0, widthM: 30, depthM: 20,
      corners: [
        { lat: 40.7413, lon: -73.9897 }, { lat: 40.7413, lon: -73.9894 },
        { lat: 40.7415, lon: -73.9894 }, { lat: 40.7415, lon: -73.9897 },
      ],
    },
    heightM: 12, heightSource: 'osm-levels', levels: 4,
    roofShape: 'flat', roofPitchDeg: null,
    size: 'small', shape: 'rect',
    svDifficulty: 'suburban', archType: 'residential',
    wallColourHint: null, roofColourHint: null,
    wallMaterialHint: null, roofMaterialHint: null,
    groundElevationM: 0, isSloped: false, slopeVector: null,
    isCampus: false, siblingBuildings: [],
    rawSolar: null, rawOsm: null, rawSmarty: null,
    ...overrides,
  };
  return { ...base, __refined: true } as unknown as RefinedBuildingContext;
}

function makeEv(polygon: LatLon[], roofShape: JointEvidence['roofShape']['value'] = 'flat'): JointEvidence {
  return {
    footprint: { value: polygon, source: 'osm', confidence: 1 },
    heightM: { value: 12, source: 'osm', confidence: 1 },
    levels: { value: 4, source: 'osm', confidence: 1 },
    wallPalette: { value: [[70, 5, 10]], source: 'sv', confidence: 0.9 },
    roofPalette: { value: [[30, 0, 0]], source: 'sat', confidence: 0.9 },
    roofShape: { value: roofShape, source: 'osm', confidence: 1 },
    windowGrid: [null, null, null, null],
    cornice: { value: false, source: 'inferred', confidence: 0.5 },
    entry: { value: { edge: 0, offsetAlongEdge: 0.5 }, source: 'inferred', confidence: 0.3 },
    trees: [], roads: [],
  };
}

/**
 * Mirror a REAL capture: `captureTiles()` always attaches per-mesh geometry
 * (see `capture/tiles.ts`), and the sliced router path is gated on it. A helper
 * that omits `meshes` leaves `tilesUsable` permanently false, so every routing
 * test would silently exercise a world the production pipeline never sees.
 * `noCoverage` ⇒ scene extraction failed ⇒ no meshes.
 */
function makeTiles(truncated = false, noCoverage = false): TileEvidence {
  return {
    glbPath: null, glbBytes: new ArrayBuffer(0),
    heightmap: new Float32Array(0), heightmapWidth: 0, heightmapLength: 0,
    measuredBbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 12, z: 20 } },
    truncated, meshCount: noCoverage ? 0 : 10, noCoverage,
    meshes: noCoverage ? [] : [{
      positions: new Float32Array([0, 0, 0, 30, 0, 0, 30, 12, 20]),
      indices: new Uint32Array([0, 1, 2]),
    }],
  };
}

describe('routeSynthesis', () => {
  // ─── Row 2: usable photogrammetry is the dominant production path ─────────
  it('→ 7d-sliced for a medium building with usable tiles', () => {
    const ctx = makeCtx({ size: 'medium', shape: 'rect' });
    expect(routeSynthesis(ctx, makeEv(ctx.polygon! as LatLon[]), makeTiles()))
      .toBe('7d-sliced');
  });
  it('→ 7d-sliced for curved footprints with usable tiles (helical fit lives there)', () => {
    // Independent visual QA (2026-07-20) showed 7b builds a BOX — the
    // helical-frustum fit is wired only on the sliced path, and the 7d
    // neighbour-merge that once scored IoU 0.57 was fixed by the cantilever
    // height gate. Curved+usable-tiles belongs on 7d.
    const ctx = makeCtx({ size: 'large', shape: 'curved' });
    expect(routeSynthesis(ctx, makeEv(ctx.polygon! as LatLon[]), makeTiles()))
      .toBe('7d-sliced');
  });
  it('→ 7d-sliced for a curved footprint with NO polygon (no 7b anchor)', () => {
    const ctx = makeCtx({ size: 'large', shape: 'curved', polygon: null, polygonSource: 'inferred' });
    expect(routeSynthesis(ctx, makeEv([]), makeTiles())).toBe('7d-sliced');
  });
  it('→ 7d-sliced for a small building whose polygon is missing', () => {
    // No polygon ⇒ the small-home rule (row 1) cannot fire, so usable tiles win.
    const ctx = makeCtx({ size: 'small', shape: 'rect', polygon: null, polygonSource: 'inferred' });
    expect(routeSynthesis(ctx, makeEv([]), makeTiles())).toBe('7d-sliced');
  });

  // ─── Row 1: small parametrizable homes prefer parametric even WITH tiles ──
  it('→ 7a-parametric for a small rect home, beating usable tiles', () => {
    // Regression guard for the small-with-polygon rule: it must take precedence
    // over the sliced path (a house is a fraction of the ~44m capture radius).
    const ctx = makeCtx({ size: 'small', shape: 'rect' });
    expect(routeSynthesis(ctx, makeEv(ctx.polygon! as LatLon[]), makeTiles()))
      .toBe('7a-parametric');
  });
  it('→ 7a-parametric for a small L-plan (U) home with usable tiles', () => {
    const ctx = makeCtx({ size: 'small', shape: 'U' });
    expect(routeSynthesis(ctx, makeEv(ctx.polygon! as LatLon[]), makeTiles()))
      .toBe('7a-parametric');
  });
  it('does NOT divert a small CURVED home to parametric (not parametrizable)', () => {
    // curved is excluded from row 1 → usable tiles win → sliced (helical fit).
    const ctx = makeCtx({ size: 'small', shape: 'curved' });
    expect(routeSynthesis(ctx, makeEv(ctx.polygon! as LatLon[]), makeTiles()))
      .toBe('7d-sliced');
  });

  // ─── Rows 3-7: fallbacks reached only when photogrammetry is NOT usable ───
  it('→ 7c-hybrid for an iconic landmark when tiles are truncated', () => {
    // Truncated tiles are not "usable" (top missing) so row 2 is skipped and the
    // iconic branch (row 3) is reached; with coverage it prefers hybrid.
    const rawOsm = {
      tags: { tourism: 'attraction', building: 'yes' },
    } as unknown as BuildingContext['rawOsm'];
    const ctx = makeCtx({ size: 'large', shape: 'rect', rawOsm });
    expect(routeSynthesis(ctx, makeEv(ctx.polygon! as LatLon[]), makeTiles(true)))
      .toBe('7c-hybrid');
  });
  it('→ 7b-cleaned-tiles for curved shapes with no coverage', () => {
    const ctx = makeCtx({ size: 'large', shape: 'curved' });
    expect(routeSynthesis(ctx, makeEv(ctx.polygon! as LatLon[]), makeTiles(false, true)))
      .toBe('7b-cleaned-tiles');
  });
  it('→ 7b-cleaned-tiles for irregular shapes with no coverage', () => {
    const ctx = makeCtx({ size: 'large', shape: 'irregular' });
    expect(routeSynthesis(ctx, makeEv(ctx.polygon! as LatLon[]), makeTiles(false, true)))
      .toBe('7b-cleaned-tiles');
  });
  it('→ 7b-cleaned-tiles when polygon null and tiles unusable', () => {
    const ctx = makeCtx({ size: 'large', polygon: null, polygonSource: 'inferred' });
    expect(routeSynthesis(ctx, makeEv([]), makeTiles(false, true)))
      .toBe('7b-cleaned-tiles');
  });
  it('→ 7a-parametric for a truncated skyscraper with polygon', () => {
    const ctx = makeCtx({ size: 'skyscraper', shape: 'rect' });
    expect(routeSynthesis(ctx, makeEv(ctx.polygon! as LatLon[]), makeTiles(true)))
      .toBe('7a-parametric');
  });
});

describe('synthesize', () => {
  it('7a path produces a parametric BRep', async () => {
    const ctx = makeCtx(); // small rect home → row 1
    const ev = makeEv(ctx.polygon! as LatLon[]);
    const { path, brep } = synthesize(ctx, ev, makeTiles());
    expect(path).toBe('7a-parametric');
    const mesh = await evaluateBRep(brep);
    expect(mesh.watertight).toBe(true);
    expect(mesh.volume).toBeGreaterThan(0);
  });
  it('7b path produces a box BRep from measured tiles', async () => {
    // curved + no coverage → row 4 (cleaned-tiles box).
    const ctx = makeCtx({ size: 'large', shape: 'curved' });
    const ev = makeEv(ctx.polygon! as LatLon[]);
    const { path, brep } = synthesize(ctx, ev, makeTiles(false, true));
    expect(path).toBe('7b-cleaned-tiles');
    expect(brep.details.length).toBe(0); // cleaned-tiles box has no features
    const mesh = await evaluateBRep(brep);
    expect(mesh.watertight).toBe(true);
    expect(mesh.volume).toBeGreaterThan(0);
  });
  it('7b path extrapolates height when truncated', async () => {
    const ctx = makeCtx({ size: 'large', shape: 'curved', heightM: 100 });
    const ev: JointEvidence = {
      ...makeEv(ctx.polygon! as LatLon[]),
      heightM: { value: 100, source: 'solar', confidence: 0.9 },
    };
    // Truncated tiles: measured only 20m
    const tiles: TileEvidence = {
      ...makeTiles(true),
      measuredBbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 20, z: 20 } },
    };
    const { brep } = synthesize(ctx, ev, tiles);
    // Top floor elevation should reflect 100m, not 20m
    const topFloor = brep.floors[brep.floors.length - 1];
    expect(topFloor.elevationM).toBeGreaterThan(80);
  });
});
