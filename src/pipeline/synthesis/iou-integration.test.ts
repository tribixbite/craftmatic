/**
 * Integration test: synthesize → evaluate → footprintIoU should be ~1.0
 * for well-formed inputs where the target polygon IS the input footprint.
 *
 * Catches bugs where the axis-remap or rotation handling causes the synth
 * mesh to sit in a different projected frame from the target polygon.
 */

import { describe, it, expect } from 'vitest';
import { synthesizeParametric } from './parametric.js';
import { evaluateBRep } from './brep.js';
import { footprintIoU } from '../verify/objective.js';
import type { BuildingContext, RefinedBuildingContext, LatLon } from '../context/types.js';
import type { JointEvidence } from '../fusion/types.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function mkCtx(overrides: Partial<BuildingContext> = {}): RefinedBuildingContext {
  const base: BuildingContext = {
    center: { lat: 40.7414, lng: -73.9895 },
    polygon: null,
    polygonSource: 'osm',
    mbr: {
      rotationDeg: 0,
      widthM: 30,
      depthM: 20,
      corners: [
        { lat: 40.7413, lon: -73.9897 }, { lat: 40.7413, lon: -73.9894 },
        { lat: 40.7415, lon: -73.9894 }, { lat: 40.7415, lon: -73.9897 },
      ],
    },
    heightM: 8,
    heightSource: 'osm-levels',
    levels: 2,
    roofShape: 'flat',
    roofPitchDeg: null,
    size: 'small',
    shape: 'rect',
    svDifficulty: 'suburban',
    archType: 'residential',
    wallColourHint: null,
    roofColourHint: null,
    wallMaterialHint: null,
    roofMaterialHint: null,
    groundElevationM: 0,
    isSloped: false,
    slopeVector: null,
    isCampus: false,
    siblingBuildings: [],
    rawSolar: null,
    rawOsm: null,
    rawSmarty: null,
    ...overrides,
  };
  return { ...base, __refined: true } as unknown as RefinedBuildingContext;
}

function mkEv(
  polygon: LatLon[],
  heightM = 8,
  levels = 2,
  roofShape: JointEvidence['roofShape']['value'] = 'flat',
): JointEvidence {
  return {
    footprint: { value: polygon, source: 'osm', confidence: 1 },
    heightM: { value: heightM, source: 'osm', confidence: 1 },
    levels: { value: levels, source: 'osm', confidence: 1 },
    wallPalette: { value: [[70, 5, 10]], source: 'sv', confidence: 0.9 },
    roofPalette: { value: [[30, 0, 0]], source: 'sat', confidence: 0.9 },
    roofShape: { value: roofShape, source: 'osm', confidence: 1 },
    windowGrid: [null, null, null, null],
    cornice: { value: false, source: 'inferred', confidence: 0.5 },
    entry: { value: { edge: 0, offsetAlongEdge: 0.5 }, source: 'inferred', confidence: 0.3 },
    trees: [],
    roads: [],
  };
}

// A small rectangle 10m (E-W) × 8m (N-S) centred on (40.7414, -73.9895)
function rectPoly(): LatLon[] {
  const center = { lat: 40.7414, lon: -73.9895 };
  const latHalf = 4 / 111_111;
  const cosLat = Math.cos(center.lat * Math.PI / 180);
  const lonHalf = 5 / (111_111 * cosLat);
  return [
    { lat: center.lat - latHalf, lon: center.lon - lonHalf },
    { lat: center.lat - latHalf, lon: center.lon + lonHalf },
    { lat: center.lat + latHalf, lon: center.lon + lonHalf },
    { lat: center.lat + latHalf, lon: center.lon - lonHalf },
  ];
}

// A wedge (Flatiron-like) — 30m E-W at the base, tapering to a point at the north
function wedgePoly(): LatLon[] {
  const center = { lat: 40.7414, lon: -73.9895 };
  const cosLat = Math.cos(center.lat * Math.PI / 180);
  const dLat15 = 7.5 / 111_111;
  const dLon15 = 15 / (111_111 * cosLat);
  return [
    { lat: center.lat - dLat15, lon: center.lon - dLon15 },
    { lat: center.lat - dLat15, lon: center.lon + dLon15 },
    { lat: center.lat + dLat15, lon: center.lon + 0 }, // apex
  ];
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('synth → evaluate → IoU (integration)', () => {
  it('rectangle footprint: IoU should be ≥ 0.90', async () => {
    const ctx = mkCtx();
    const ev = mkEv(rectPoly());
    const brep = synthesizeParametric(ctx, ev);
    const mesh = await evaluateBRep(brep);
    const iou = footprintIoU(
      mesh.positions, mesh.indices,
      ev.footprint.value,
      ctx.center, ctx.mbr.rotationDeg,
    );
    expect(iou).toBeGreaterThan(0.90);
  });

  it('wedge (asymmetric) footprint: IoU should be ≥ 0.85 — catches Z-mirror bug', async () => {
    const ctx = mkCtx({ shape: 'wedge' });
    const ev = mkEv(wedgePoly());
    const brep = synthesizeParametric(ctx, ev);
    const mesh = await evaluateBRep(brep);
    const iou = footprintIoU(
      mesh.positions, mesh.indices,
      ev.footprint.value,
      ctx.center, ctx.mbr.rotationDeg,
    );
    expect(iou).toBeGreaterThan(0.85);
  });

  it('rotated MBR: IoU should still be ≥ 0.85', async () => {
    const ctx = mkCtx({
      mbr: {
        rotationDeg: 30,
        widthM: 30, depthM: 20,
        corners: [
          { lat: 0, lon: 0 }, { lat: 0, lon: 0 }, { lat: 0, lon: 0 }, { lat: 0, lon: 0 },
        ],
      },
    });
    const ev = mkEv(rectPoly());
    const brep = synthesizeParametric(ctx, ev);
    const mesh = await evaluateBRep(brep);
    const iou = footprintIoU(
      mesh.positions, mesh.indices,
      ev.footprint.value,
      ctx.center, ctx.mbr.rotationDeg,
    );
    expect(iou).toBeGreaterThan(0.85);
  });

  it('height error should be < 10% for flat-roof synth', async () => {
    const ctx = mkCtx();
    const ev = mkEv(rectPoly(), 8, 2, 'flat');
    const brep = synthesizeParametric(ctx, ev);
    const mesh = await evaluateBRep(brep);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < mesh.positions.length; i += 3) {
      if (mesh.positions[i] < minY) minY = mesh.positions[i];
      if (mesh.positions[i] > maxY) maxY = mesh.positions[i];
    }
    const measured = maxY - minY;
    const err = Math.abs(measured - 8) / 8;
    expect(err).toBeLessThan(0.10);
  });

  it('height error should be < 10% for gabled synth', async () => {
    const ctx = mkCtx();
    const ev = mkEv(rectPoly(), 8, 2, 'gabled');
    const brep = synthesizeParametric(ctx, ev);
    const mesh = await evaluateBRep(brep);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < mesh.positions.length; i += 3) {
      if (mesh.positions[i] < minY) minY = mesh.positions[i];
      if (mesh.positions[i] > maxY) maxY = mesh.positions[i];
    }
    const measured = maxY - minY;
    const err = Math.abs(measured - 8) / 8;
    expect(err).toBeLessThan(0.10);
  });

  it('height error should be < 10% when OSM levels disagrees with heightM (Flatiron case)', async () => {
    // 87m building with OSM reporting only 7 levels (previously produced 71% error)
    const ctx = mkCtx({ archType: 'historic', size: 'medium', levels: 7 });
    const ev = mkEv(wedgePoly(), 87, 7, 'flat');
    const brep = synthesizeParametric(ctx, ev);
    const mesh = await evaluateBRep(brep);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < mesh.positions.length; i += 3) {
      if (mesh.positions[i] < minY) minY = mesh.positions[i];
      if (mesh.positions[i] > maxY) maxY = mesh.positions[i];
    }
    const measured = maxY - minY;
    const err = Math.abs(measured - 87) / 87;
    expect(err).toBeLessThan(0.10);
  });
});
