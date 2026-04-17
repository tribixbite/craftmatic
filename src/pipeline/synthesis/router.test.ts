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

function makeTiles(truncated = false, noCoverage = false): TileEvidence {
  return {
    glbPath: null, glbBytes: new ArrayBuffer(0),
    heightmap: new Float32Array(0), heightmapWidth: 0, heightmapLength: 0,
    measuredBbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 12, z: 20 } },
    truncated, meshCount: noCoverage ? 0 : 10, noCoverage,
  };
}

describe('routeSynthesis', () => {
  it('→ 7a-parametric for rect with polygon, no truncation', () => {
    const ctx = makeCtx({ shape: 'rect' });
    const ev = makeEv(ctx.polygon! as LatLon[]);
    expect(routeSynthesis(ctx, ev, makeTiles())).toBe('7a-parametric');
  });
  it('→ 7b-cleaned-tiles for curved shapes', () => {
    const ctx = makeCtx({ shape: 'curved' });
    const ev = makeEv(ctx.polygon! as LatLon[]);
    expect(routeSynthesis(ctx, ev, makeTiles())).toBe('7b-cleaned-tiles');
  });
  it('→ 7b-cleaned-tiles for irregular shapes', () => {
    const ctx = makeCtx({ shape: 'irregular' });
    expect(routeSynthesis(ctx, makeEv(ctx.polygon! as LatLon[]), makeTiles()))
      .toBe('7b-cleaned-tiles');
  });
  it('→ 7b-cleaned-tiles when polygon null', () => {
    const ctx = makeCtx({ polygon: null, polygonSource: 'inferred' });
    expect(routeSynthesis(ctx, makeEv([]), makeTiles())).toBe('7b-cleaned-tiles');
  });
  it('→ 7a-parametric for truncated skyscraper with polygon', () => {
    const ctx = makeCtx({ size: 'skyscraper', shape: 'rect' });
    const ev = makeEv(ctx.polygon! as LatLon[]);
    expect(routeSynthesis(ctx, ev, makeTiles(true))).toBe('7a-parametric');
  });
  it('→ 7c-hybrid for iconic landmark (tourism=attraction)', () => {
    const rawOsm = {
      tags: { tourism: 'attraction', building: 'yes' },
    } as unknown as BuildingContext['rawOsm'];
    const ctx = makeCtx({ shape: 'rect', rawOsm });
    expect(routeSynthesis(ctx, makeEv(ctx.polygon! as LatLon[]), makeTiles()))
      .toBe('7c-hybrid');
  });
});

describe('synthesize', () => {
  it('7a path produces a parametric BRep', async () => {
    const ctx = makeCtx();
    const ev = makeEv(ctx.polygon! as LatLon[]);
    const { path, brep } = synthesize(ctx, ev, makeTiles());
    expect(path).toBe('7a-parametric');
    const mesh = await evaluateBRep(brep);
    expect(mesh.watertight).toBe(true);
    expect(mesh.volume).toBeGreaterThan(0);
  });
  it('7b path produces a box BRep from measured tiles', async () => {
    const ctx = makeCtx({ shape: 'curved' });
    const ev = makeEv(ctx.polygon! as LatLon[]);
    const { path, brep } = synthesize(ctx, ev, makeTiles());
    expect(path).toBe('7b-cleaned-tiles');
    expect(brep.details.length).toBe(0); // cleaned-tiles box has no features
    const mesh = await evaluateBRep(brep);
    expect(mesh.watertight).toBe(true);
    expect(mesh.volume).toBeGreaterThan(0);
  });
  it('7b path extrapolates height when truncated', async () => {
    const ctx = makeCtx({ shape: 'curved', heightM: 100 });
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
