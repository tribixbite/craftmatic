/**
 * Objective-gate self-test (Tekton `demo:corrupt` → refuse → `demo:restore`).
 *
 * Synthesizes a REAL building mesh through the production path
 * (`synthesizeParametric` → `evaluateBRep`), confirms the clean output passes
 * every objective gate, then deliberately corrupts it the way the pipeline
 * fails in the field and asserts each corruption makes the matching gate refuse.
 * The closing "restore" case re-runs the clean inputs to prove it was the
 * corruption — not the harness — that tripped the gate.
 *
 * This complements `objective.test.ts` (which unit-tests the gate functions on
 * toy meshes) by proving the gates have teeth on building-shaped geometry.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { synthesizeParametric } from '../synthesis/parametric.js';
import { evaluateBRep } from '../synthesis/brep.js';
import { runObjectiveGates, type ObjectiveInputs } from './objective.js';
import {
  crushHeight,
  shiftFootprint,
  mergeNeighbour,
  punctureMesh,
  type MeshArrays,
} from './corruption.js';
import { BlockGrid } from '../../schem/types.js';
import type { BuildingContext, RefinedBuildingContext, LatLon } from '../context/types.js';
import type { JointEvidence } from '../fusion/types.js';

// ─── Fixtures (mirror synthesis/iou-integration.test.ts) ─────────────────────

const CENTER = { lat: 40.7414, lng: -73.9895 };
const HEIGHT_M = 24; // ~6 storeys — tall enough that a height crush is unambiguous
const WIDTH_M = 30; // E-W extent of the rect footprint

function mkCtx(): RefinedBuildingContext {
  const base: BuildingContext = {
    center: CENTER,
    polygon: null,
    polygonSource: 'osm',
    mbr: {
      rotationDeg: 0,
      widthM: WIDTH_M,
      depthM: 20,
      corners: [
        { lat: 40.7413, lon: -73.9897 }, { lat: 40.7413, lon: -73.9894 },
        { lat: 40.7415, lon: -73.9894 }, { lat: 40.7415, lon: -73.9897 },
      ],
    },
    heightM: HEIGHT_M,
    heightSource: 'osm-levels',
    levels: 6,
    roofShape: 'flat',
    roofPitchDeg: null,
    size: 'medium',
    shape: 'rect',
    svDifficulty: 'dense-urban',
    archType: 'commercial',
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
  };
  return { ...base, __refined: true } as unknown as RefinedBuildingContext;
}

function mkEv(polygon: LatLon[]): JointEvidence {
  return {
    footprint: { value: polygon, source: 'osm', confidence: 1 },
    heightM: { value: HEIGHT_M, source: 'osm', confidence: 1 },
    levels: { value: 6, source: 'osm', confidence: 1 },
    wallPalette: { value: [[70, 5, 10]], source: 'sv', confidence: 0.9 },
    roofPalette: { value: [[30, 0, 0]], source: 'sat', confidence: 0.9 },
    roofShape: { value: 'flat', source: 'osm', confidence: 1 },
    windowGrid: [null, null, null, null],
    cornice: { value: false, source: 'inferred', confidence: 0.5 },
    entry: { value: { edge: 0, offsetAlongEdge: 0.5 }, source: 'inferred', confidence: 0.3 },
    trees: [],
    roads: [],
  };
}

// A 30m (E-W) × 20m (N-S) rectangle centred on CENTER.
function rectPoly(): LatLon[] {
  const latHalf = 10 / 111_111;
  const cosLat = Math.cos(CENTER.lat * Math.PI / 180);
  const lonHalf = 15 / (111_111 * cosLat);
  return [
    { lat: CENTER.lat - latHalf, lon: CENTER.lng - lonHalf },
    { lat: CENTER.lat - latHalf, lon: CENTER.lng + lonHalf },
    { lat: CENTER.lat + latHalf, lon: CENTER.lng + lonHalf },
    { lat: CENTER.lat + latHalf, lon: CENTER.lng - lonHalf },
  ];
}

// ─── Shared clean baseline ───────────────────────────────────────────────────

let cleanMesh: MeshArrays;
let target: readonly LatLon[];

/** Build ObjectiveInputs from a (possibly corrupted) mesh against the clean
 *  target polygon, origin, rotation, expected height and a non-empty grid. */
function inputsFor(mesh: MeshArrays, grid?: BlockGrid): ObjectiveInputs {
  return {
    positions: mesh.positions,
    indices: mesh.indices,
    targetPolygon: target,
    meshOrigin: CENTER,
    meshRotationDeg: 0,
    expectedHeightM: HEIGHT_M,
    grid: grid ?? filledGrid(),
  };
}

/** A small non-empty grid so the voxel-occupancy gate passes cleanly. */
function filledGrid(): BlockGrid {
  const g = new BlockGrid(8, 8, 8);
  for (let y = 0; y < 4; y++) {
    for (let z = 0; z < 4; z++) {
      for (let x = 0; x < 4; x++) g.set(x, y, z, 'minecraft:stone');
    }
  }
  return g;
}

beforeAll(async () => {
  const ev = mkEv(rectPoly());
  target = ev.footprint.value;
  const brep = synthesizeParametric(mkCtx(), ev);
  cleanMesh = await evaluateBRep(brep);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('objective-gate self-test (corrupt → refuse → restore)', () => {
  it('clean synthesized building passes every objective gate', () => {
    const r = runObjectiveGates(inputsFor(cleanMesh));
    expect(r.failures).toEqual([]);
    expect(r.pass).toBe(true);
    // Sanity on the individual metrics that the corruptions will break.
    expect(r.footprintIoU).toBeGreaterThan(0.85);
    expect(r.heightErr).toBeLessThan(0.10);
    expect(r.watertight).toBe(true);
    expect(r.manifold).toBe(true);
  });

  it('height truncation refuses at the height gate', () => {
    // Crush to 50% height → ~50% error, far past the 10% gate.
    const r = runObjectiveGates(inputsFor(crushHeight(cleanMesh, 0.5)));
    expect(r.pass).toBe(false);
    expect(r.failures.join(';')).toMatch(/height error/i);
    expect(r.heightErr).toBeGreaterThan(0.10);
    // Corruption is isolated: topology untouched.
    expect(r.watertight).toBe(true);
  });

  it('footprint mis-registration refuses at the IoU gate', () => {
    // Slide the whole building 1.5× its width off the target → ~no overlap.
    const r = runObjectiveGates(inputsFor(shiftFootprint(cleanMesh, WIDTH_M * 1.5, 0)));
    expect(r.pass).toBe(false);
    expect(r.failures.join(';')).toMatch(/footprint IoU/i);
    expect(r.footprintIoU).toBeLessThan(0.85);
    expect(r.watertight).toBe(true);
  });

  it('merged neighbour refuses at the IoU gate (watertight stays intact)', () => {
    // Second closed solid 1.3× width away → silhouette doubles, IoU ≈ 0.5.
    const r = runObjectiveGates(inputsFor(mergeNeighbour(cleanMesh, WIDTH_M * 1.3)));
    expect(r.pass).toBe(false);
    expect(r.failures.join(';')).toMatch(/footprint IoU/i);
    expect(r.footprintIoU).toBeLessThan(0.85);
    // Both components are closed solids → no boundary edges.
    expect(r.watertight).toBe(true);
  });

  it('punctured facade refuses at the watertight gate', () => {
    const r = runObjectiveGates(inputsFor(punctureMesh(cleanMesh, 6)));
    expect(r.pass).toBe(false);
    expect(r.failures.join(';')).toMatch(/watertight/i);
    expect(r.watertight).toBe(false);
    // Removing faces drops shared edges 2→1; never raises any above 2.
    expect(r.manifold).toBe(true);
  });

  it('empty voxel grid refuses at the occupancy gate', () => {
    const r = runObjectiveGates(inputsFor(cleanMesh, new BlockGrid(4, 4, 4)));
    expect(r.pass).toBe(false);
    expect(r.failures.join(';')).toMatch(/voxel grid empty/i);
  });

  it('restore: re-running the clean inputs passes again', () => {
    const r = runObjectiveGates(inputsFor(cleanMesh));
    expect(r.pass).toBe(true);
  });
});
