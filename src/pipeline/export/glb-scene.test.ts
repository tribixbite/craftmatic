import { describe, it, expect } from 'vitest';
import { exportSceneGlb } from './glb-scene.js';
import { parseGlbJson } from './glb-writer.js';
import type { BuildingBRep, MaterialRef } from '../synthesis/brep.js';
import type { JointEvidence } from '../fusion/types.js';
import type { LocalPoint2D } from '../context/types.js';

function mat(block: string): MaterialRef {
  return { blockName: block, lab: [60, 0, 0] };
}

function boxBrep(): BuildingBRep {
  const poly: LocalPoint2D[] = [
    { x: -5, z: -5 }, { x: 5, z: -5 }, { x: 5, z: 5 }, { x: -5, z: 5 },
  ];
  return {
    origin: { lat: 40.7414, lng: -73.9895 }, rotationDeg: 0,
    floors: [{ level: 0, elevationM: 0, thicknessM: 0.3, polygon: poly }],
    walls: [
      { level: 0, facadeEdge: 0, start: poly[0], end: poly[1], heightM: 3, thicknessM: 0.3, material: 'wall' },
      { level: 0, facadeEdge: 1, start: poly[1], end: poly[2], heightM: 3, thicknessM: 0.3, material: 'wall' },
      { level: 0, facadeEdge: 2, start: poly[2], end: poly[3], heightM: 3, thicknessM: 0.3, material: 'wall' },
      { level: 0, facadeEdge: 3, start: poly[3], end: poly[0], heightM: 3, thicknessM: 0.3, material: 'wall' },
    ],
    roof: { type: 'flat', baseZ: 3.3, peakZ: 3.8, pitchDeg: 0, polygon: poly, params: {} },
    details: [],
    materials: {
      wall: mat('minecraft:stone_bricks'),
      trim: mat('minecraft:smooth_stone'),
      roof: mat('minecraft:deepslate_tiles'),
      window: mat('minecraft:glass'),
    },
  };
}

function evidence(overrides: Partial<JointEvidence> = {}): JointEvidence {
  return {
    footprint: { value: [], source: 'inferred', confidence: 0.4 },
    heightM: { value: 3, source: 'inferred', confidence: 0.5 },
    levels: { value: 1, source: 'inferred', confidence: 0.5 },
    wallPalette: { value: [[70, 0, 0]], source: 'inferred', confidence: 0.5 },
    roofPalette: { value: [[30, 0, 0]], source: 'inferred', confidence: 0.5 },
    roofShape: { value: 'flat', source: 'inferred', confidence: 0.5 },
    windowGrid: [null, null, null, null],
    cornice: { value: false, source: 'inferred', confidence: 0.5 },
    entry: { value: { edge: 0, offsetAlongEdge: 0.5 }, source: 'inferred', confidence: 0.3 },
    trees: [], roads: [],
    ...overrides,
  };
}

describe('exportSceneGlb', () => {
  it('produces building + ground plane by default', async () => {
    const result = await exportSceneGlb(boxBrep(), evidence());
    expect(result.meshCount).toBe(2);
    expect(result.treeCount).toBe(0);
    const root = parseGlbJson(result.glbBytes);
    const names = root.nodes.map(n => n.name);
    expect(names).toContain('building');
    expect(names).toContain('ground');
  });

  it('skips ground when opts.ground=false', async () => {
    const result = await exportSceneGlb(boxBrep(), evidence(), { ground: false });
    expect(result.meshCount).toBe(1);
  });

  it('emits a mesh per tree instance', async () => {
    const origin = { lat: 40.7414, lon: -73.9895 };
    const result = await exportSceneGlb(boxBrep(), evidence({
      trees: [
        { position: { lat: origin.lat + 0.0001, lon: origin.lon }, radiusM: 3, source: 'osm' },
        { position: { lat: origin.lat, lon: origin.lon + 0.0001 }, radiusM: 4, source: 'sat' },
      ],
    }));
    expect(result.treeCount).toBe(2);
    expect(result.meshCount).toBe(4); // building + ground + 2 trees
  });

  it('trees honour opts.trees=false', async () => {
    const origin = { lat: 40.7414, lon: -73.9895 };
    const result = await exportSceneGlb(boxBrep(), evidence({
      trees: [{ position: { lat: origin.lat + 0.0001, lon: origin.lon }, radiusM: 3, source: 'osm' }],
    }), { trees: false });
    expect(result.treeCount).toBe(0);
    expect(result.meshCount).toBe(2);
  });
});
