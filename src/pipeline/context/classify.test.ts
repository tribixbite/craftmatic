import { describe, it, expect } from 'vitest';
import {
  classifySize,
  classifyShape,
  classifySvDifficulty,
  classifyArchType,
  isCampusCluster,
  refineContextWithTiles,
  signedPolygonArea,
  douglasPeucker,
} from './classify.js';
import type { BuildingContext, LatLon } from './types.js';
import type { OSMBuildingData } from '../../gen/api/osm.js';

// ─── Synthetic polygons for shape tests ─────────────────────────────────────
// Units: degrees (approx), but we only care about relative geometry.
// A 20m building near the equator is ~0.00018°.

function rect(wDeg = 0.0002, hDeg = 0.00015): readonly LatLon[] {
  return [
    { lat: 0,    lon: 0 },
    { lat: wDeg, lon: 0 },
    { lat: wDeg, lon: hDeg },
    { lat: 0,    lon: hDeg },
    { lat: 0,    lon: 0 },
  ];
}

function triangle(): readonly LatLon[] {
  return [
    { lat: 0,       lon: 0 },
    { lat: 0.0003,  lon: 0 },
    { lat: 0.00015, lon: 0.0002 },
    { lat: 0,       lon: 0 },
  ];
}

function uShape(): readonly LatLon[] {
  // A U — 8 vertices with one concavity
  return [
    { lat: 0,       lon: 0 },
    { lat: 0.0003,  lon: 0 },
    { lat: 0.0003,  lon: 0.0001 },
    { lat: 0.0002,  lon: 0.0001 },
    { lat: 0.0002,  lon: 0.00005 },
    { lat: 0.0001,  lon: 0.00005 },
    { lat: 0.0001,  lon: 0.0001 },
    { lat: 0,       lon: 0.0001 },
    { lat: 0,       lon: 0 },
  ];
}

function multiWing(): readonly LatLon[] {
  // A plus-sign shape — 12 vertices, 4 concavities
  const r = 0.0001;
  const w = 0.00005;
  return [
    { lat: -w, lon: -r },
    { lat:  w, lon: -r },
    { lat:  w, lon: -w },
    { lat:  r, lon: -w },
    { lat:  r, lon:  w },
    { lat:  w, lon:  w },
    { lat:  w, lon:  r },
    { lat: -w, lon:  r },
    { lat: -w, lon:  w },
    { lat: -r, lon:  w },
    { lat: -r, lon: -w },
    { lat: -w, lon: -w },
    { lat: -w, lon: -r },
  ];
}

function circle(vertices = 24, rDeg = 0.00015): readonly LatLon[] {
  const out: LatLon[] = [];
  for (let i = 0; i < vertices; i++) {
    const theta = (i / vertices) * Math.PI * 2;
    out.push({ lat: Math.cos(theta) * rDeg, lon: Math.sin(theta) * rDeg });
  }
  out.push(out[0]);
  return out;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('classifySize', () => {
  it('tiny under 15m', () => expect(classifySize(12, 10, false)).toBe('tiny'));
  it('small 15-50m', () => expect(classifySize(30, 20, false)).toBe('small'));
  it('medium 50-150m', () => expect(classifySize(80, 60, false)).toBe('medium'));
  it('large 150-300m', () => expect(classifySize(200, 100, false)).toBe('large'));
  it('skyscraper ≥300m', () => expect(classifySize(400, 60, false)).toBe('skyscraper'));
  it('campus overrides max-dim', () => expect(classifySize(20, 20, true)).toBe('campus'));
});

describe('classifyShape', () => {
  it('rect from 4-vertex rectangle', () => {
    expect(classifyShape({ polygon: rect() })).toBe('rect');
  });
  it('wedge from triangle', () => {
    expect(classifyShape({ polygon: triangle() })).toBe('wedge');
  });
  it('courtyard from inner ring', () => {
    expect(classifyShape({ polygon: rect(0.0005, 0.0005), innerRings: [rect(0.0002, 0.0002)] }))
      .toBe('courtyard');
  });
  it('U from single-concavity polygon', () => {
    expect(classifyShape({ polygon: uShape() })).toBe('U');
  });
  it('multi-wing from plus-sign', () => {
    expect(classifyShape({ polygon: multiWing() })).toBe('multi-wing');
  });
  it('curved from 24-vertex circle', () => {
    expect(classifyShape({ polygon: circle(24) })).toBe('curved');
  });
});

describe('classifySvDifficulty', () => {
  const mkOsm = (tags: Record<string, string>): OSMBuildingData => ({
    type: 'way', id: 1, tags, polygon: [], widthMeters: 20, lengthMeters: 20,
    height: null, levels: null, area: 400,
  } as unknown as OSMBuildingData);

  it('no-coverage flag wins', () => {
    expect(classifySvDifficulty({ center: { lat: 0, lng: 0 }, osm: null, knownNoCoverage: true }))
      .toBe('no-coverage');
  });
  it('dense-urban for commercial/retail/office buildings', () => {
    expect(classifySvDifficulty({ center: { lat: 0, lng: 0 }, osm: mkOsm({ building: 'commercial' }) }))
      .toBe('dense-urban');
  });
  it('rural-occluded when landuse is rural', () => {
    expect(classifySvDifficulty({
      center: { lat: 0, lng: 0 },
      osm: mkOsm({ building: 'house', landuse: 'farmland' }),
    })).toBe('rural-occluded');
  });
  it('suburban fallback', () => {
    expect(classifySvDifficulty({
      center: { lat: 0, lng: 0 },
      osm: mkOsm({ building: 'house' }),
    })).toBe('suburban');
  });
});

describe('classifyArchType', () => {
  const mkOsm = (tags: Record<string, string>): OSMBuildingData => ({
    type: 'way', id: 1, tags, polygon: [], widthMeters: 20, lengthMeters: 20,
    height: null, levels: null, area: 400,
  } as unknown as OSMBuildingData);

  it('historic from tag', () => {
    expect(classifyArchType(mkOsm({ historic: 'building' }))).toBe('historic');
  });
  it('religious from place_of_worship', () => {
    expect(classifyArchType(mkOsm({ amenity: 'place_of_worship' }))).toBe('religious');
  });
  it('civic from townhall', () => {
    expect(classifyArchType(mkOsm({ amenity: 'townhall' }))).toBe('civic');
  });
  it('industrial from landuse', () => {
    expect(classifyArchType(mkOsm({ building: 'industrial' }))).toBe('industrial');
  });
  it('commercial from shop tag', () => {
    expect(classifyArchType(mkOsm({ shop: 'supermarket', building: 'retail' }))).toBe('commercial');
  });
  it('residential fallback', () => {
    expect(classifyArchType(mkOsm({ building: 'house' }))).toBe('residential');
  });
  it('residential for null OSM', () => {
    expect(classifyArchType(null)).toBe('residential');
  });
});

describe('isCampusCluster', () => {
  it('false when <2 siblings', () => {
    expect(isCampusCluster([{ tags: { 'building:part': 'yes' }, distanceM: 10 }])).toBe(false);
  });
  it('false when siblings are far', () => {
    expect(isCampusCluster([
      { tags: { 'building:part': 'yes' }, distanceM: 100 },
      { tags: { 'building:part': 'yes' }, distanceM: 100 },
    ])).toBe(false);
  });
  it('false when no sibling has building:part', () => {
    expect(isCampusCluster([
      { tags: { building: 'yes' }, distanceM: 10 },
      { tags: { building: 'yes' }, distanceM: 10 },
    ])).toBe(false);
  });
  it('true when 2+ nearby siblings with building:part', () => {
    expect(isCampusCluster([
      { tags: { 'building:part': 'yes' }, distanceM: 10 },
      { tags: { 'building:part': 'roof' }, distanceM: 15 },
    ])).toBe(true);
  });
});

describe('refineContextWithTiles', () => {
  const baseCtx: BuildingContext = {
    center: { lat: 0, lng: 0 },
    polygon: null, polygonSource: 'inferred',
    mbr: {
      rotationDeg: 0, widthM: 80, depthM: 80,
      corners: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0 }, { lat: 0, lon: 0 }, { lat: 0, lon: 0 }],
    },
    heightM: 100, heightSource: 'tiles', levels: null,
    roofShape: 'flat', roofPitchDeg: null,
    size: 'medium', shape: 'rect',
    svDifficulty: 'dense-urban', archType: 'commercial',
    wallColourHint: null, roofColourHint: null,
    wallMaterialHint: null, roofMaterialHint: null,
    groundElevationM: 0, isSloped: false, slopeVector: null,
    isCampus: false, siblingBuildings: [],
    rawSolar: null, rawOsm: null, rawSmarty: null,
  };

  it('leaves shape unchanged for flat heightmap', () => {
    const W = 8, L = 8;
    const hm = new Float32Array(W * L).fill(30);
    const refined = refineContextWithTiles(baseCtx, { heightmap: hm, heightmapWidth: W, heightmapLength: L });
    expect(refined.shape).toBe('rect');
  });

  it('refines to tower-podium when centre is tall and surround is short', () => {
    const W = 10, L = 10;
    const hm = new Float32Array(W * L);
    for (let z = 0; z < L; z++) {
      for (let x = 0; x < W; x++) {
        // Tall (150m) centre 4x4, short (20m) surround
        const inCentre = x >= 3 && x < 7 && z >= 3 && z < 7;
        hm[z * W + x] = inCentre ? 150 : 20;
      }
    }
    const refined = refineContextWithTiles(baseCtx, { heightmap: hm, heightmapWidth: W, heightmapLength: L });
    expect(refined.shape).toBe('tower-podium');
  });

  it('does not refine when building is too short overall', () => {
    const W = 10, L = 10;
    const hm = new Float32Array(W * L);
    for (let z = 0; z < L; z++) {
      for (let x = 0; x < W; x++) {
        const inCentre = x >= 3 && x < 7 && z >= 3 && z < 7;
        hm[z * W + x] = inCentre ? 20 : 10;
      }
    }
    const refined = refineContextWithTiles(baseCtx, { heightmap: hm, heightmapWidth: W, heightmapLength: L });
    expect(refined.shape).toBe('rect');
  });
});

// Basic sanity on geometry helpers
describe('geometry helpers', () => {
  it('signedPolygonArea is positive for CCW polygon', () => {
    expect(signedPolygonArea(rect())).toBeGreaterThan(0);
  });
  it('douglasPeucker reduces a noisy straight line to 2 points', () => {
    const pts: LatLon[] = [];
    for (let i = 0; i < 20; i++) pts.push({ lat: i * 0.0001, lon: 0.0000001 * Math.random() });
    const simp = douglasPeucker(pts, 0.000001);
    expect(simp.length).toBeLessThan(10);
  });
});
