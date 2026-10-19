import { describe, it, expect } from 'vitest';
import {
  fuseEvidence,
  reconcileFootprint,
  reconcileHeight,
  tileFootprintGroundY,
  reconcileLevels,
  reconcileRoofShape,
  reconcileWallPalette,
  reconcileRoofPalette,
  reconcileCornice,
  reconcileWindowGrid,
} from './reconcile.js';
import type { BuildingContext, Lab, LatLon } from '../context/types.js';
import type { SvEvidence, SvFacadeEvidence, TileEvidence, SatEvidence } from '../capture/types.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const C = { lat: 40.7414, lng: -73.9895 } as const;

function baseCtx(overrides: Partial<BuildingContext> = {}): BuildingContext {
  return {
    center: { lat: C.lat, lng: C.lng },
    polygon: null, polygonSource: 'inferred',
    mbr: {
      rotationDeg: 0, widthM: 30, depthM: 20,
      corners: [
        { lat: C.lat, lon: C.lng }, { lat: C.lat, lon: C.lng },
        { lat: C.lat, lon: C.lng }, { lat: C.lat, lon: C.lng },
      ],
    },
    heightM: null, heightSource: null, levels: null,
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
}

function makeTiles(bboxMaxY: number, truncated = false, meshCount = 10): TileEvidence {
  return {
    glbPath: null, glbBytes: new ArrayBuffer(0),
    heightmap: new Float32Array(0), heightmapWidth: 0, heightmapLength: 0,
    measuredBbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: bboxMaxY, z: 20 } },
    truncated, meshCount, noCoverage: meshCount < 3,
  };
}

function makeSvFacade(edge: number, wallLab: Lab, overrides: Partial<SvFacadeEvidence> = {}): SvFacadeEvidence {
  return {
    facadeEdge: edge,
    imagePath: null, imageBytes: new ArrayBuffer(0),
    panoId: `pano-${edge}`, panoDistM: 40, headingDeg: edge * 90, fovDeg: 75, pitchDeg: 10,
    sniff: { sky: 0.2, veg: 0.05, building: 0.75 },
    palette: { wall: wallLab, trim: wallLab, accent: null },
    windowGrid: null,
    cornice: false,
    occlusion: 'none',
    confidence: 0.85,
    ...overrides,
  };
}

function makeSat(primary: Lab, secondary: Lab | null = null): SatEvidence {
  return {
    imagePath: null, hiresImagePath: null,
    imageBytes: new ArrayBuffer(0), hiresImageBytes: null,
    zoom: 20,
    treeMask: new Uint8Array(0), treeMaskDim: { w: 0, h: 0 },
    roofPalette: { primary, secondary },
    shadowAzimuthDeg: null,
  };
}

// ─── Footprint ────────────────────────────────────────────────────────────

describe('reconcileFootprint', () => {
  const poly: LatLon[] = [
    { lat: 0, lon: 0 }, { lat: 0, lon: 0.0001 },
    { lat: 0.0001, lon: 0.0001 }, { lat: 0.0001, lon: 0 },
  ];
  it('OSM polygon → source=osm, confidence=1', () => {
    const r = reconcileFootprint(baseCtx({ polygon: poly, polygonSource: 'osm' }), null);
    expect(r.source).toBe('osm');
    expect(r.confidence).toBeCloseTo(1.0);
  });
  it('Solar bbox polygon → source=solar', () => {
    const r = reconcileFootprint(baseCtx({ polygon: poly, polygonSource: 'solar-bbox' }), null);
    expect(r.source).toBe('solar');
  });
  it('MBR corners fallback when polygon is null', () => {
    const r = reconcileFootprint(baseCtx(), null);
    expect(r.source).toBe('inferred');
    expect(r.value.length).toBe(4);
  });
});

// ─── Height ────────────────────────────────────────────────────────────────

describe('reconcileHeight', () => {
  it('prefers tiles when non-truncated', () => {
    const r = reconcileHeight(baseCtx({ heightM: 30, heightSource: 'osm-levels' }), makeTiles(28));
    expect(r.source).toBe('tiles');
    expect(r.value).toBe(28);
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });
  it('ignores tiles when truncated — falls back to Solar', () => {
    const r = reconcileHeight(
      baseCtx({ heightM: 100, heightSource: 'solar' }),
      makeTiles(30, true),
    );
    expect(r.source).toBe('solar');
    expect(r.value).toBe(100);
  });
  it('uses archType default when no source set', () => {
    const r = reconcileHeight(baseCtx({ archType: 'civic' }), null);
    expect(r.source).toBe('inferred');
    expect(r.value).toBe(18);
  });

  it('rejects tiles >30% taller than surveyed (sub-grade noise)', () => {
    // OSM/Solar says 30m; photogrammetry measures 50m (sub-grade entrance,
    // sidewalks, neighbour spillover). Should reject tiles measurement.
    const r = reconcileHeight(
      baseCtx({ heightM: 30, heightSource: 'solar' }),
      makeTiles(50),
    );
    expect(r.source).toBe('solar');
    expect(r.value).toBe(30);
  });

  it('falls back to archType×5 / footprint×0.9 cap when surveyed absent', () => {
    // No surveyed height. Tall tiles measurement of 51m for residential
    // (default 8m × 5 = 40m) with 31×21m footprint (diag×0.9 = 33.7m)
    // should be REJECTED — falls back to archType default 8m.
    const r = reconcileHeight(
      baseCtx({ archType: 'residential', mbr: { rotationDeg: 0, widthM: 31, depthM: 21, corners: [] as never } }),
      makeTiles(51),
    );
    expect(r.source).toBe('inferred');
    expect(r.value).toBe(8);
  });

  it('accepts tiles within archType×5 cap when surveyed absent', () => {
    // Civic, 88×60m base → archCap 18×5=90m, footprintCap 100×0.9=90m,
    // 73m measurement passes.
    const r = reconcileHeight(
      baseCtx({ archType: 'civic', mbr: { rotationDeg: 0, widthM: 88, depthM: 60, corners: [] as never } }),
      makeTiles(73),
    );
    expect(r.source).toBe('tiles');
    expect(r.value).toBe(73);
  });

  it('measures from the ground at the footprint, not the capture minimum', () => {
    // geisel's failure mode: a ~33 m building on a canyon edge. The capture
    // spans canyon floor (y=0) → roof (y=58); the plaza around the footprint
    // sits 25 m above the floor. Height must be 58 − 25 = 33, not 58.
    const dLat = 10 / 111_111;
    const dLon = 10 / (111_111 * Math.cos(C.lat * Math.PI / 180));
    const polygon: LatLon[] = [
      { lat: C.lat - dLat, lon: C.lng - dLon }, { lat: C.lat - dLat, lon: C.lng + dLon },
      { lat: C.lat + dLat, lon: C.lng + dLon }, { lat: C.lat + dLat, lon: C.lng - dLon },
    ];
    const W = 60, L = 60; // 1 m cells, corner at (-30, -30)
    const heightmap = new Float32Array(W * L);
    for (let z = 0; z < L; z++) {
      for (let x = 0; x < W; x++) heightmap[z * W + x] = x < 8 ? 0.5 : 25; // canyon west of x = -22
    }
    const tiles: TileEvidence = {
      ...makeTiles(58),
      heightmap, heightmapWidth: W, heightmapLength: L,
      measuredBbox: { min: { x: -30, y: 0, z: -30 }, max: { x: 30, y: 58, z: 30 } },
    };
    const r = reconcileHeight(
      baseCtx({ archType: 'civic', polygon, polygonSource: 'osm', mbr: { rotationDeg: 0, widthM: 20, depthM: 20, corners: [] as never } }),
      tiles,
    );
    expect(r.source).toBe('tiles');
    expect(r.value).toBeCloseTo(33, 5);
  });

  it('tileFootprintGroundY is the absolute scene Y of the ring, null without a polygon', () => {
    const dLat = 10 / 111_111;
    const dLon = 10 / (111_111 * Math.cos(C.lat * Math.PI / 180));
    const polygon: LatLon[] = [
      { lat: C.lat - dLat, lon: C.lng - dLon }, { lat: C.lat - dLat, lon: C.lng + dLon },
      { lat: C.lat + dLat, lon: C.lng + dLon }, { lat: C.lat + dLat, lon: C.lng - dLon },
    ];
    const W = 60, L = 60;
    const heightmap = new Float32Array(W * L).fill(12); // ring 12 m above the capture min
    const tiles: TileEvidence = {
      ...makeTiles(40),
      heightmap, heightmapWidth: W, heightmapLength: L,
      measuredBbox: { min: { x: -30, y: 100, z: -30 }, max: { x: 30, y: 140, z: 30 } },
    };
    expect(tileFootprintGroundY({ polygon, center: { lat: C.lat, lng: C.lng } }, tiles)).toBeCloseTo(112, 5);
    expect(tileFootprintGroundY({ polygon: null, center: { lat: C.lat, lng: C.lng } }, tiles)).toBeNull();
  });
});

// ─── Levels ────────────────────────────────────────────────────────────────

describe('reconcileLevels', () => {
  it('OSM levels wins', () => {
    const r = reconcileLevels(baseCtx({ levels: 12 }), [], { value: 60, source: 'tiles', confidence: 1 });
    expect(r.value).toBe(12);
    expect(r.source).toBe('osm');
  });
  it('SV median rows used when OSM absent', () => {
    const sv: SvEvidence = [
      { ...makeSvFacade(0, [50, 0, 0]), windowGrid: { rows: 10, cols: 4, confidence: 0.7 } },
      { ...makeSvFacade(1, [50, 0, 0]), windowGrid: { rows: 12, cols: 4, confidence: 0.7 } },
      { ...makeSvFacade(2, [50, 0, 0]), windowGrid: { rows: 11, cols: 4, confidence: 0.7 } },
    ];
    const r = reconcileLevels(baseCtx(), sv, { value: 40, source: 'tiles', confidence: 1 });
    expect(r.source).toBe('sv');
    expect(r.value).toBe(11);
  });
  it('archType floor-height fallback', () => {
    const r = reconcileLevels(baseCtx({ archType: 'commercial' }), [], { value: 40, source: 'tiles', confidence: 0.9 });
    expect(r.source).toBe('inferred');
    expect(r.value).toBe(10); // 40 / 4
  });
});

// ─── Palettes ──────────────────────────────────────────────────────────────

describe('reconcileWallPalette', () => {
  it('SV wall palette wins', () => {
    const sv: SvEvidence = [makeSvFacade(0, [70, 10, 20])];
    const r = reconcileWallPalette(baseCtx(), sv);
    expect(r.source).toBe('sv');
    expect(r.value.length).toBeGreaterThanOrEqual(1);
  });
  it('confidence boosted when OSM agrees within delta-E 10', () => {
    // OSM 'white' — Lab ≈ [100, 0, 0]
    const sv: SvEvidence = [makeSvFacade(0, [100, 0, 0])];
    const r = reconcileWallPalette(baseCtx({ wallColourHint: '#FFFFFF' }), sv);
    expect(r.confidence).toBeCloseTo(1.0, 1);
  });
  it('confidence downgraded when OSM disagrees by > delta-E 20', () => {
    const sv: SvEvidence = [makeSvFacade(0, [100, 0, 0])];
    const r = reconcileWallPalette(baseCtx({ wallColourHint: '#000000' }), sv);
    expect(r.confidence).toBeLessThan(0.8);
  });
  it('falls back to OSM tag when no SV evidence', () => {
    const r = reconcileWallPalette(baseCtx({ wallColourHint: '#CCCCCC' }), []);
    expect(r.source).toBe('osm');
  });
  it('medium-grey default when nothing available', () => {
    const r = reconcileWallPalette(baseCtx(), []);
    expect(r.source).toBe('inferred');
    expect(r.confidence).toBeLessThan(0.5);
  });
});

describe('reconcileRoofPalette', () => {
  it('satellite primary wins', () => {
    const r = reconcileRoofPalette(baseCtx(), makeSat([60, 5, 10]));
    expect(r.source).toBe('sat');
  });
  it('archType default when no sat, no OSM tag', () => {
    const r = reconcileRoofPalette(baseCtx({ archType: 'residential' }), null);
    expect(r.source).toBe('inferred');
    expect(r.value.length).toBe(1);
  });
});

// ─── Roof shape ────────────────────────────────────────────────────────────

describe('reconcileRoofShape', () => {
  it('OSM roof:shape tag wins', () => {
    const ctx = baseCtx({
      roofShape: 'gabled',
      rawOsm: { tags: { 'roof:shape': 'gabled' } } as unknown as BuildingContext['rawOsm'],
    });
    const r = reconcileRoofShape(ctx);
    expect(r.source).toBe('osm');
    expect(r.value).toBe('gabled');
  });
  it('pitch > 15° → gabled for residential / hipped for others', () => {
    const r = reconcileRoofShape(baseCtx({ roofPitchDeg: 30, archType: 'residential' }));
    expect(r.value).toBe('gabled');
    const r2 = reconcileRoofShape(baseCtx({ roofPitchDeg: 30, archType: 'civic' }));
    expect(r2.value).toBe('hipped');
  });
  it('default by archType when no source', () => {
    expect(reconcileRoofShape(baseCtx({ archType: 'residential' })).value).toBe('gabled');
    expect(reconcileRoofShape(baseCtx({ archType: 'commercial' })).value).toBe('flat');
    expect(reconcileRoofShape(baseCtx({ archType: 'religious' })).value).toBe('hipped');
  });
});

// ─── Window grid ──────────────────────────────────────────────────────────

describe('reconcileWindowGrid', () => {
  it('returns 4-element array, one per MBR edge', () => {
    const r = reconcileWindowGrid(baseCtx(), [], { value: 3, source: 'osm', confidence: 0.9 });
    expect(r.length).toBe(4);
    for (const e of r) expect(e?.value.rows).toBe(3);
  });
  it('uses SV detection when present', () => {
    const sv: SvEvidence = [{
      ...makeSvFacade(0, [50, 0, 0]),
      windowGrid: { rows: 5, cols: 3, confidence: 0.8 },
    }];
    const r = reconcileWindowGrid(baseCtx(), sv, { value: 3, source: 'osm', confidence: 0.9 });
    expect(r[0]?.source).toBe('sv');
    expect(r[0]?.value.rows).toBe(5);
    // other edges still get procedural
    expect(r[1]?.source).toBe('inferred');
  });
});

// ─── Cornice ──────────────────────────────────────────────────────────────

describe('reconcileCornice', () => {
  it('SV cornice detection wins', () => {
    const sv: SvEvidence = [{ ...makeSvFacade(0, [50, 0, 0]), cornice: true }];
    const r = reconcileCornice(baseCtx(), sv);
    expect(r.source).toBe('sv');
    expect(r.value).toBe(true);
  });
  it('historic/civic/religious default to cornice=true', () => {
    expect(reconcileCornice(baseCtx({ archType: 'historic' }), []).value).toBe(true);
  });
  it('residential defaults to no cornice', () => {
    expect(reconcileCornice(baseCtx({ archType: 'residential' }), []).value).toBe(false);
  });
});

// ─── fuseEvidence orchestrator ────────────────────────────────────────────

describe('fuseEvidence', () => {
  it('produces a complete JointEvidence from minimal inputs', () => {
    const je = fuseEvidence({ ctx: baseCtx(), tiles: null, sv: [], sat: null });
    expect(je.footprint.value).toBeDefined();
    expect(je.heightM.value).toBeGreaterThan(0);
    expect(je.levels.value).toBeGreaterThan(0);
    expect(je.wallPalette.value.length).toBeGreaterThan(0);
    expect(je.roofPalette.value.length).toBeGreaterThan(0);
    expect(je.windowGrid.length).toBe(4);
    expect(je.cornice.value).toBeDefined();
    expect(je.entry.value.edge).toBeDefined();
    expect(je.trees).toEqual([]);
    expect(je.roads).toEqual([]);
  });

  it('all primary sources cooperate → high confidences', () => {
    const poly: LatLon[] = [
      { lat: 0, lon: 0 }, { lat: 0, lon: 0.0001 },
      { lat: 0.0001, lon: 0.0001 }, { lat: 0.0001, lon: 0 },
    ];
    const ctx = baseCtx({
      polygon: poly, polygonSource: 'osm',
      heightM: 30, heightSource: 'osm-levels', levels: 10,
      wallColourHint: '#FFFFFF', roofColourHint: '#333333',
    });
    const sv: SvEvidence = [makeSvFacade(0, [100, 0, 0]), makeSvFacade(1, [100, 0, 0])];
    const tiles = makeTiles(30);
    const sat = makeSat([30, 0, 0]);
    const je = fuseEvidence({ ctx, tiles, sv, sat });
    expect(je.footprint.confidence).toBeGreaterThanOrEqual(0.95);
    expect(je.heightM.confidence).toBeGreaterThanOrEqual(0.9); // tiles wins
    expect(je.levels.confidence).toBeGreaterThanOrEqual(0.9);  // OSM wins
    expect(je.wallPalette.confidence).toBeGreaterThanOrEqual(0.9); // SV+OSM agree
    expect(je.roofPalette.confidence).toBeGreaterThanOrEqual(0.9); // sat+OSM agree
  });
});

describe('footprint confidence vs geocode pin quality', () => {
  const poly = [
    { lat: 0, lon: 0 }, { lat: 0, lon: 0.0001 },
    { lat: 0.0001, lon: 0.0001 }, { lat: 0.0001, lon: 0 },
  ];
  it('keeps 1.0 for ROOFTOP (and legacy contexts without the field)', () => {
    expect(reconcileFootprint(baseCtx({ polygon: poly, polygonSource: 'osm', geocodeLocationType: 'ROOFTOP' }), null).confidence).toBe(1.0);
    expect(reconcileFootprint(baseCtx({ polygon: poly, polygonSource: 'osm' }), null).confidence).toBe(1.0);
  });
  it('degrades RANGE_INTERPOLATED to 0.85 (wrong-parcel risk)', () => {
    expect(reconcileFootprint(baseCtx({ polygon: poly, polygonSource: 'osm', geocodeLocationType: 'RANGE_INTERPOLATED' }), null).confidence).toBe(0.85);
  });
  it('degrades GEOMETRIC_CENTER to 0.7', () => {
    expect(reconcileFootprint(baseCtx({ polygon: poly, polygonSource: 'osm', geocodeLocationType: 'GEOMETRIC_CENTER' }), null).confidence).toBe(0.7);
  });
});

describe('roof palette vegetation guard', () => {
  function satWith(lab: [number, number, number], masked: boolean | undefined) {
    return {
      roofPalette: { primary: lab, secondary: null },
      ...(masked !== undefined ? { roofPaletteMaskedToFootprint: masked } : {}),
    } as unknown as Parameters<typeof reconcileRoofPalette>[1];
  }
  it('distrusts unmasked vegetation-green (the Berwyn lawn roof)', () => {
    const r = reconcileRoofPalette(baseCtx({}), satWith([51, -18, 15], false));
    expect(r.confidence).toBeLessThanOrEqual(0.35);
  });
  it('legacy captures without the flag are treated as unmasked', () => {
    const r = reconcileRoofPalette(baseCtx({}), satWith([51, -18, 15], undefined));
    expect(r.confidence).toBeLessThanOrEqual(0.35);
  });
  it('keeps confidence for footprint-masked green (real verdigris roof)', () => {
    const r = reconcileRoofPalette(baseCtx({}), satWith([51, -18, 15], true));
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });
  it('non-green roofs unaffected either way', () => {
    const r = reconcileRoofPalette(baseCtx({}), satWith([40, 5, 10], false));
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });
});

describe('wall palette shade guard', () => {
  function svWith(lab: [number, number, number]) {
    return [{
      confidence: 0.9, occlusion: 'none',
      palette: { wall: lab, trim: [50, 0, 0], accent: null },
    }] as unknown as Parameters<typeof reconcileWallPalette>[1];
  }
  it('distrusts near-black SV walls on residential (shaded pano)', () => {
    const r = reconcileWallPalette(baseCtx({ archType: 'residential' }), svWith([18, 2, 2]));
    expect(r.confidence).toBeLessThanOrEqual(0.4);
  });
  it('keeps near-black on commercial (dark curtain wall is plausible)', () => {
    const r = reconcileWallPalette(baseCtx({ archType: 'commercial' }), svWith([18, 2, 2]));
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });
  it('normal-luminance residential walls unaffected', () => {
    const r = reconcileWallPalette(baseCtx({ archType: 'residential' }), svWith([65, 5, 10]));
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });
});
