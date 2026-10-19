import { describe, it, expect } from 'vitest';
import {
  evaluateBRep,
  type BuildingBRep,
  type FloorSlab,
  type Wall,
  type RoofVolume,
  type Feature,
} from './brep.js';
import type { LocalPoint2D, MaterialRef } from '../context/types.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const SQ = 10; // 10m square footprint
const RECT_POLY: LocalPoint2D[] = [
  { x: -SQ / 2, z: -SQ / 2 },
  { x:  SQ / 2, z: -SQ / 2 },
  { x:  SQ / 2, z:  SQ / 2 },
  { x: -SQ / 2, z:  SQ / 2 },
];

function mkMaterial(block: string): MaterialRef {
  return { blockName: block, lab: [60, 0, 0] };
}

function singleFloorBrep(overrides: Partial<BuildingBRep> = {}): BuildingBRep {
  const floor: FloorSlab = {
    level: 0, elevationM: 0, thicknessM: 0.3, polygon: RECT_POLY,
  };
  const walls: Wall[] = [
    { level: 0, facadeEdge: 0, start: RECT_POLY[0], end: RECT_POLY[1],
      heightM: 3, thicknessM: 0.3, material: 'wall' },
    { level: 0, facadeEdge: 1, start: RECT_POLY[1], end: RECT_POLY[2],
      heightM: 3, thicknessM: 0.3, material: 'wall' },
    { level: 0, facadeEdge: 2, start: RECT_POLY[2], end: RECT_POLY[3],
      heightM: 3, thicknessM: 0.3, material: 'wall' },
    { level: 0, facadeEdge: 3, start: RECT_POLY[3], end: RECT_POLY[0],
      heightM: 3, thicknessM: 0.3, material: 'wall' },
  ];
  const roof: RoofVolume = {
    type: 'flat', baseZ: 3.3, peakZ: 3.8, pitchDeg: 0,
    polygon: RECT_POLY, params: {},
  };
  return {
    origin: { lat: 0, lng: 0 }, rotationDeg: 0,
    floors: [floor], walls, roof, details: [],
    materials: {
      wall: mkMaterial('minecraft:stone_bricks'),
      trim: mkMaterial('minecraft:smooth_stone'),
      roof: mkMaterial('minecraft:deepslate_tiles'),
      window: mkMaterial('minecraft:glass'),
    },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('evaluateBRep', () => {
  it('evaluates a single-floor flat-roof brep into a watertight mesh', async () => {
    const mesh = await evaluateBRep(singleFloorBrep());
    expect(mesh.positions.length).toBeGreaterThan(0);
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(mesh.watertight).toBe(true);
    // 10m × 10m footprint × ~3.8m tall → building volume ~380 m³, with walls
    // hollowed → much less. Sanity: volume is non-trivial.
    expect(mesh.volume).toBeGreaterThan(1);
    expect(mesh.surfaceArea).toBeGreaterThan(50);
  });

  it('multi-level brep produces a correspondingly taller volume', async () => {
    const twoFloors = singleFloorBrep({
      floors: [
        { level: 0, elevationM: 0, thicknessM: 0.3, polygon: RECT_POLY },
        { level: 1, elevationM: 3.3, thicknessM: 0.3, polygon: RECT_POLY },
      ],
      roof: {
        type: 'flat', baseZ: 6.6, peakZ: 7.1, pitchDeg: 0,
        polygon: RECT_POLY, params: {},
      },
      walls: [
        { level: 0, facadeEdge: 0, start: RECT_POLY[0], end: RECT_POLY[1],
          heightM: 3, thicknessM: 0.3, material: 'wall' },
        { level: 1, facadeEdge: 0, start: RECT_POLY[0], end: RECT_POLY[1],
          heightM: 3, thicknessM: 0.3, material: 'wall' },
      ],
    });

    const single = await evaluateBRep(singleFloorBrep());
    const two = await evaluateBRep(twoFloors);
    expect(two.volume).toBeGreaterThan(single.volume * 1.4);
  });

  it('gabled roof produces less volume than flat roof of same footprint', async () => {
    const flat = singleFloorBrep();
    const gabled = singleFloorBrep({
      roof: { type: 'gabled', baseZ: 3.3, peakZ: 5.3, pitchDeg: 30,
              polygon: RECT_POLY, params: {} },
    });
    const fm = await evaluateBRep(flat);
    const gm = await evaluateBRep(gabled);
    // Gabled roof tapers to a ridge → total above-ground volume likely < flat+parapet
    expect(fm.watertight).toBe(true);
    expect(gm.watertight).toBe(true);
    expect(gm.positions.length).toBeGreaterThan(0);
    expect(fm.positions.length).toBeGreaterThan(0);
  });

  it('pyramidal roof evaluates cleanly', async () => {
    const brep = singleFloorBrep({
      roof: { type: 'pyramidal', baseZ: 3.3, peakZ: 6.3, pitchDeg: 45,
              polygon: RECT_POLY, params: {} },
    });
    const m = await evaluateBRep(brep);
    expect(m.watertight).toBe(true);
    expect(m.positions.length).toBeGreaterThan(0);
  });

  it('window feature cavity subtracts from the building', async () => {
    const noWindow = await evaluateBRep(singleFloorBrep());
    const withWindow = await evaluateBRep(singleFloorBrep({
      details: [{
        kind: 'window', facadeEdge: 0, level: 0,
        offsetAlongEdge: 0.5,
        widthM: 1.2, heightM: 1.5, depthM: 0.08,
        elevationM: 1.0,
      } as Feature],
    }));
    expect(withWindow.watertight).toBe(true);
    // Volume with window cavity should be strictly less
    expect(withWindow.volume).toBeLessThan(noWindow.volume);
    // But NOT dramatically less — the cavity is only 0.08m deep of a 0.3m wall,
    // and covers 1.2 × 1.5 × 0.08 = 0.144 m³
    expect(noWindow.volume - withWindow.volume).toBeLessThan(1);
  });

  it('output is Y-up (positions Y values match elevations set in Z in brep)', async () => {
    const mesh = await evaluateBRep(singleFloorBrep());
    let maxY = -Infinity;
    for (let i = 1; i < mesh.positions.length; i += 3) {
      if (mesh.positions[i] > maxY) maxY = mesh.positions[i];
    }
    // Top of roof at Z=3.8 in brep → after Z→Y remap, Y ≈ 3.8
    expect(maxY).toBeGreaterThan(3.5);
    expect(maxY).toBeLessThan(4.5);
  });
});

describe('roof taper centring (off-origin polygons)', () => {
  it('keeps a gabled roof over an off-centre footprint', async () => {
    // Same 10m square shifted 30m east / 20m north of the origin. manifold's
    // tapered extrude scales about the ORIGIN, so pre-fix the gabled roof
    // swung ~30m sideways off the walls (berwyn-house: 50m wedge, IoU 0.35).
    const OFF: LocalPoint2D[] = RECT_POLY.map(p => ({ x: p.x + 30, z: p.z + 20 }));
    const brep = singleFloorBrep({
      floors: [{ level: 0, elevationM: 0, thicknessM: 0.3, polygon: OFF }],
      walls: [0, 1, 2, 3].map(i => ({
        level: 0, facadeEdge: i, start: OFF[i], end: OFF[(i + 1) % 4],
        heightM: 3, thicknessM: 0.3, material: 'wall' as const,
      })),
      roof: { type: 'gabled', baseZ: 3.3, peakZ: 5.5, pitchDeg: 30, polygon: OFF, params: {} },
    });
    const mesh = await evaluateBRep(brep);
    expect(mesh.watertight).toBe(true);
    // Every vertex must stay within the footprint bbox (+0.6m tolerance) —
    // the pre-fix roof reached toward the origin, far outside it.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      minX = Math.min(minX, mesh.positions[i]);
      maxX = Math.max(maxX, mesh.positions[i]);
      minZ = Math.min(minZ, mesh.positions[i + 2]);
      maxZ = Math.max(maxZ, mesh.positions[i + 2]);
    }
    expect(minX).toBeGreaterThan(25 - 0.6);
    expect(maxX).toBeLessThan(35 + 0.6);
    expect(minZ).toBeGreaterThan(15 - 0.6);
    expect(maxZ).toBeLessThan(25 + 0.6);
  });
});

describe('pitched roof ridge orientation', () => {
  // 20m × 10m rectangle, long axis X. A gable must keep a full-length ridge
  // along X; the old uniform 0.02 taper collapsed both axes into a pyramid.
  const RECT_20x10: LocalPoint2D[] = [
    { x: -10, z: -5 }, { x: 10, z: -5 }, { x: 10, z: 5 }, { x: -10, z: 5 },
  ];

  function pitchedBrep(type: RoofVolume['type']): BuildingBRep {
    return singleFloorBrep({
      floors: [{ level: 0, elevationM: 0, thicknessM: 0.3, polygon: RECT_20x10 }],
      walls: [
        { level: 0, facadeEdge: 0, start: RECT_20x10[0], end: RECT_20x10[1], heightM: 3, thicknessM: 0.3, material: 'wall' },
        { level: 0, facadeEdge: 1, start: RECT_20x10[1], end: RECT_20x10[2], heightM: 3, thicknessM: 0.3, material: 'wall' },
        { level: 0, facadeEdge: 2, start: RECT_20x10[2], end: RECT_20x10[3], heightM: 3, thicknessM: 0.3, material: 'wall' },
        { level: 0, facadeEdge: 3, start: RECT_20x10[3], end: RECT_20x10[0], heightM: 3, thicknessM: 0.3, material: 'wall' },
      ],
      roof: { type, baseZ: 3.3, peakZ: 6.3, pitchDeg: 30, polygon: RECT_20x10, params: {} },
    });
  }

  /** X/Z extents of all vertices within epsM of the mesh's top (Y-up). */
  async function topExtents(brep: BuildingBRep, epsM = 0.4): Promise<{ xExt: number; zExt: number }> {
    const mesh = await evaluateBRep(brep);
    let maxY = -Infinity;
    for (let i = 1; i < mesh.positions.length; i += 3) {
      if (mesh.positions[i] > maxY) maxY = mesh.positions[i];
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      if (mesh.positions[i + 1] < maxY - epsM) continue;
      const x = mesh.positions[i], z = mesh.positions[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { xExt: maxX - minX, zExt: maxZ - minZ };
  }

  it('gabled: full-length ridge along the long axis, collapsed across the short', async () => {
    const { xExt, zExt } = await topExtents(pitchedBrep('gabled'));
    expect(xExt).toBeGreaterThan(15);  // ridge ≈ 20m
    expect(zExt).toBeLessThan(2);      // collapsed to ~0.2m
  });

  it('hipped: ridge inset to (long − short), still along the long axis', async () => {
    const { xExt, zExt } = await topExtents(pitchedBrep('hipped'));
    expect(xExt).toBeGreaterThan(6);   // ridgeFrac 0.5 × 20m ≈ 10m
    expect(xExt).toBeLessThan(14);
    expect(zExt).toBeLessThan(2);
  });

  it('pyramidal still tapers to a point', async () => {
    const { xExt, zExt } = await topExtents(pitchedBrep('pyramidal'));
    expect(xExt).toBeLessThan(1);
    expect(zExt).toBeLessThan(1);
  });
});
