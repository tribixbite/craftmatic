import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  buildTileEvidenceFromGroup,
  runBrowserPipelineFromTiles,
} from './browser-entry.js';
import type { BuildingContext, LatLon } from './context/types.js';
import type { CaptureProfile } from './context/types.js';
import type { StreetViewFetchers } from './capture/streetview.js';
import type { SatelliteFetcher } from './capture/satellite.js';

function makeCubeMesh(size = 10): THREE.Mesh {
  const geo = new THREE.BoxGeometry(size, size, size);
  const mat = new THREE.MeshStandardMaterial({ color: 0x808080 });
  return new THREE.Mesh(geo, mat);
}

function makeCtx(): BuildingContext {
  const poly: LatLon[] = [
    { lat: 40.7413, lon: -73.9897 }, { lat: 40.7413, lon: -73.9894 },
    { lat: 40.7415, lon: -73.9894 }, { lat: 40.7415, lon: -73.9897 },
  ];
  return {
    center: { lat: 40.7414, lng: -73.9895 },
    polygon: poly, polygonSource: 'osm',
    mbr: { rotationDeg: 0, widthM: 30, depthM: 20, corners: [poly[0], poly[1], poly[2], poly[3]] },
    heightM: 12, heightSource: 'osm-levels', levels: 4,
    roofShape: 'flat', roofPitchDeg: null,
    size: 'small', shape: 'rect',
    svDifficulty: 'no-coverage', archType: 'residential',
    wallColourHint: null, roofColourHint: null,
    wallMaterialHint: null, roofMaterialHint: null,
    groundElevationM: 0, isSloped: false, slopeVector: null,
    isCampus: false, siblingBuildings: [],
    rawSolar: null, rawOsm: null, rawSmarty: null,
  };
}

function profile(): CaptureProfile {
  return {
    tiles: { radiusM: 40, errorTarget: 2, verticalBands: 1, cameraMode: 'perspective', expectedHeightM: 12 },
    streetview: { dirCount: 0, offsetM: 30, maxPanoDistM: 80, angleVariants: [0], minBuildingPixelRatio: 0.2, pitchDeg: 10 },
    satellite: { scale: 1, maskTrees: false },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('buildTileEvidenceFromGroup', () => {
  it('turns a Three.js group into a TileEvidence', async () => {
    const group = new THREE.Group();
    group.add(makeCubeMesh(10));
    const { evidence, meshes } = await buildTileEvidenceFromGroup({ group, expectedHeightM: 10 });
    expect(meshes.length).toBe(1);
    expect(evidence.meshCount).toBe(1);
    expect(evidence.measuredBbox.max.x).toBeCloseTo(5);
    expect(evidence.measuredBbox.max.y).toBeCloseTo(5);
    expect(evidence.heightmapWidth).toBeGreaterThan(0);
    expect(evidence.glbBytes.byteLength).toBeGreaterThan(0);
  });

  it('flags noCoverage when fewer than 3 meshes', async () => {
    const group = new THREE.Group();
    const { evidence } = await buildTileEvidenceFromGroup({ group, expectedHeightM: 10 });
    expect(evidence.noCoverage).toBe(true);
  });

  it('detects truncation when captured < 60% of expected', async () => {
    const group = new THREE.Group();
    group.add(makeCubeMesh(10)); // 10m captured, but expected 100
    group.add(makeCubeMesh(10));
    group.add(makeCubeMesh(10));
    const { evidence } = await buildTileEvidenceFromGroup({ group, expectedHeightM: 100 });
    expect(evidence.truncated).toBe(true);
  });
});

describe('runBrowserPipelineFromTiles', () => {
  const ctx = makeCtx();
  const svFetchers: StreetViewFetchers = {
    metadata: async () => null, // no-coverage profile → not called
    image: async () => { throw new Error('should not be called for no-coverage'); },
  };
  const satFetcher: SatelliteFetcher = async ({ size, scale }) => {
    const rgba = new Uint8Array(size * scale * size * scale * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 128; rgba[i + 1] = 128; rgba[i + 2] = 128; rgba[i + 3] = 255;
    }
    return { bytes: new Uint8Array(0), width: size * scale, height: size * scale, rgba };
  };

  it('produces a full pipeline result from a null tiles + no-SV path', async () => {
    const result = await runBrowserPipelineFromTiles({
      ctx, profile: profile(), tiles: null, svFetchers, satFetcher,
    });
    expect(result.artifacts.printGlbBytes.byteLength).toBeGreaterThan(0);
    expect(result.artifacts.sceneGlbBytes.byteLength).toBeGreaterThan(0);
    expect(result.artifacts.voxelBlockCount).toBeGreaterThan(0);
    expect(result.artifacts.captures.tiles).toBeNull();
    expect(result.artifacts.captures.sv).toEqual([]);
    expect(result.report.status).toMatch(/pass|fail-consensus|fail-objective/);
  }, 20_000);

  it('forwards progress callbacks across stages', async () => {
    const stages = new Set<string>();
    await runBrowserPipelineFromTiles({
      ctx, profile: profile(), tiles: null, svFetchers, satFetcher,
      onProgress: ({ stage }) => { stages.add(stage); },
    });
    expect(stages.has('satellite')).toBe(true);
  }, 20_000);
});
