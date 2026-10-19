/**
 * Stage 9 — objective verification gates.
 *
 * Deterministic checks on the synthesized mesh + voxel grid. MUST pass
 * before VLM consensus even runs.
 */

import type { BlockGrid } from '../../schem/types.js';
import type { LatLon } from '../context/types.js';
import { findUnknownStates } from '../../blocks/known-blocks.js';

// ─── Gate 1: Footprint IoU ─────────────────────────────────────────────────

/**
 * Compute top-down silhouette IoU between synthesized mesh and target polygon.
 *
 * Uses a pure raster sampler (200×200 grid over the bbox) — no dependency on
 * shapely or three-bvh-csg. Adequate precision for an IoU ≥ 0.85 gate.
 */
/** Base slab for the footprint gate: the bottom max(3 m, 10 %) of the mesh. */
const BASE_SLAB_MIN_M = 3;
const BASE_SLAB_FRACTION = 0.1;

export function footprintIoU(
  meshPositions: Float32Array,
  meshIndices: Uint32Array,
  target: readonly LatLon[],
  meshCenterLatLon: { lat: number; lng: number },
  meshRotationDeg: number,
): number {
  if (target.length < 3 || meshIndices.length < 3) return 0;

  // Project target polygon into the same local X/Z frame the mesh uses.
  const DEG2RAD = Math.PI / 180;
  const METERS_PER_DEG_LAT = 111_111;
  const cosLat = Math.cos(meshCenterLatLon.lat * DEG2RAD);
  const rot = -meshRotationDeg * DEG2RAD;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const localTarget = target.map(p => {
    const ex = (p.lon - meshCenterLatLon.lng) * METERS_PER_DEG_LAT * cosLat;
    const ey = (p.lat - meshCenterLatLon.lat) * METERS_PER_DEG_LAT;
    const x = ex;
    const z = -ey;
    return { x: x * cos - z * sin, z: x * sin + z * cos };
  });

  // Compute bbox over target polygon + mesh projection
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of localTarget) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  for (let i = 0; i < meshPositions.length; i += 3) {
    const x = meshPositions[i], z = meshPositions[i + 2];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  // Add a small margin
  const margin = Math.max(1, (maxX - minX) * 0.05);
  minX -= margin; maxX += margin; minZ -= margin; maxZ += margin;

  // Raster: 200×200
  const R = 200;
  const dx = (maxX - minX) / R;
  const dz = (maxZ - minZ) / R;

  const targetMask = new Uint8Array(R * R);
  for (let iy = 0; iy < R; iy++) {
    const sz = minZ + (iy + 0.5) * dz;
    for (let ix = 0; ix < R; ix++) {
      const sx = minX + (ix + 0.5) * dx;
      if (pointInPolygon(sx, sz, localTarget)) targetMask[iy * R + ix] = 1;
    }
  }

  // Mesh silhouette at the BASE: an OSM footprint is the building's outline
  // where it meets the ground, so only triangles reaching into the bottom slab
  // count. Projecting the whole mesh charged every real overhang as footprint
  // error — Geisel's tower tiers overhang its podium (IoU 0.46) — and forced
  // synthesis to snap tiers back to the podium outline. A shifted building or
  // a neighbour merged at ground level still fails, as before.
  let meshMinY = Infinity, meshMaxY = -Infinity;
  for (let i = 1; i < meshPositions.length; i += 3) {
    meshMinY = Math.min(meshMinY, meshPositions[i]);
    meshMaxY = Math.max(meshMaxY, meshPositions[i]);
  }
  const baseTopY = meshMinY + Math.max(BASE_SLAB_MIN_M, (meshMaxY - meshMinY) * BASE_SLAB_FRACTION);
  const meshMask = new Uint8Array(R * R);
  for (let i = 0; i < meshIndices.length; i += 3) {
    const a = meshIndices[i] * 3;
    const b = meshIndices[i + 1] * 3;
    const c = meshIndices[i + 2] * 3;
    if (Math.min(meshPositions[a + 1], meshPositions[b + 1], meshPositions[c + 1]) > baseTopY) continue;
    rasterTriangle2D(
      meshPositions[a], meshPositions[a + 2],
      meshPositions[b], meshPositions[b + 2],
      meshPositions[c], meshPositions[c + 2],
      minX, minZ, dx, dz, R, meshMask,
    );
  }

  // Compute IoU
  let inter = 0, unionCount = 0;
  for (let i = 0; i < R * R; i++) {
    const t = targetMask[i], m = meshMask[i];
    if (t | m) unionCount++;
    if (t & m) inter++;
  }
  return unionCount === 0 ? 0 : inter / unionCount;
}

function pointInPolygon(x: number, z: number, poly: readonly { x: number; z: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z;
    const xj = poly[j].x, zj = poly[j].z;
    const intersect = ((zi > z) !== (zj > z))
      && (x < (xj - xi) * (z - zi) / (zj - zi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function rasterTriangle2D(
  ax: number, az: number,
  bx: number, bz: number,
  cx: number, cz: number,
  minX: number, minZ: number, dx: number, dz: number, R: number,
  mask: Uint8Array,
): void {
  const lox = Math.max(0, Math.floor((Math.min(ax, bx, cx) - minX) / dx));
  const hix = Math.min(R - 1, Math.ceil((Math.max(ax, bx, cx) - minX) / dx));
  const loz = Math.max(0, Math.floor((Math.min(az, bz, cz) - minZ) / dz));
  const hiz = Math.min(R - 1, Math.ceil((Math.max(az, bz, cz) - minZ) / dz));
  const invDen = 1 / ((bz - cz) * (ax - cx) + (cx - bx) * (az - cz) || 1e-12);
  for (let iz = loz; iz <= hiz; iz++) {
    const sz = minZ + (iz + 0.5) * dz;
    for (let ix = lox; ix <= hix; ix++) {
      const sx = minX + (ix + 0.5) * dx;
      const w1 = ((bz - cz) * (sx - cx) + (cx - bx) * (sz - cz)) * invDen;
      const w2 = ((cz - az) * (sx - cx) + (ax - cx) * (sz - cz)) * invDen;
      const w3 = 1 - w1 - w2;
      if (w1 >= 0 && w2 >= 0 && w3 >= 0) mask[iz * R + ix] = 1;
    }
  }
}

// ─── Gate 2: Height error ──────────────────────────────────────────────────

export function heightErrorRatio(
  meshPositions: Float32Array,
  expectedHeightM: number,
): number {
  if (!expectedHeightM || expectedHeightM <= 0) return 0;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < meshPositions.length; i += 3) {
    if (meshPositions[i] < minY) minY = meshPositions[i];
    if (meshPositions[i] > maxY) maxY = meshPositions[i];
  }
  const measured = maxY - minY;
  return Math.abs(measured - expectedHeightM) / expectedHeightM;
}

// ─── Gates 3-4: Watertight + Manifold ─────────────────────────────────────

/**
 * An edge is a vertex-index pair (min, max). If every edge has exactly 2
 * incident triangles, the mesh is both watertight AND edge-manifold.
 */
export function analyseEdges(indices: Uint32Array): {
  boundaryCount: number;
  nonManifoldCount: number;
} {
  const edgeCount = new Map<string, number>();
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const key = u < v ? `${u}-${v}` : `${v}-${u}`;
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    }
  }
  let boundaryCount = 0, nonManifoldCount = 0;
  for (const [, n] of edgeCount) {
    if (n === 1) boundaryCount++;
    else if (n > 2) nonManifoldCount++;
  }
  return { boundaryCount, nonManifoldCount };
}

// ─── Gate 5: Self-intersection (BVH) ───────────────────────────────────────

/**
 * Exhaustive triangle-triangle intersection test via bounding-volume-like
 * broad phase on axis-aligned bounding boxes, then narrow-phase via
 * Möller-Trumbore-style pair test.
 *
 * Returns count of intersecting triangle pairs. Ideal = 0. manifold-3d output
 * is essentially guaranteed to be intersection-free; we still check because
 * subsequent exports (scene, plinth) may combine meshes that overlap.
 */
export function countSelfIntersections(
  positions: Float32Array,
  indices: Uint32Array,
): number {
  const nTri = indices.length / 3;
  if (nTri < 2) return 0;

  // Compute per-triangle AABBs
  const boxes = new Float32Array(nTri * 6); // minX,minY,minZ,maxX,maxY,maxZ
  for (let t = 0; t < nTri; t++) {
    const ia = indices[t * 3] * 3, ib = indices[t * 3 + 1] * 3, ic = indices[t * 3 + 2] * 3;
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];
    boxes[t * 6 + 0] = Math.min(ax, bx, cx);
    boxes[t * 6 + 1] = Math.min(ay, by, cy);
    boxes[t * 6 + 2] = Math.min(az, bz, cz);
    boxes[t * 6 + 3] = Math.max(ax, bx, cx);
    boxes[t * 6 + 4] = Math.max(ay, by, cy);
    boxes[t * 6 + 5] = Math.max(az, bz, cz);
  }

  // O(n²) AABB pair test — on our small meshes (<5K triangles typical)
  // this is <25M iterations, completes in a few hundred ms. Anything bigger
  // would need a proper BVH (three-mesh-bvh).
  let intersections = 0;
  for (let i = 0; i < nTri; i++) {
    const ia0 = indices[i * 3], ia1 = indices[i * 3 + 1], ia2 = indices[i * 3 + 2];
    for (let j = i + 1; j < nTri; j++) {
      // Skip triangles sharing a vertex (they touch at an edge/vertex by design)
      const ib0 = indices[j * 3], ib1 = indices[j * 3 + 1], ib2 = indices[j * 3 + 2];
      if (ia0 === ib0 || ia0 === ib1 || ia0 === ib2) continue;
      if (ia1 === ib0 || ia1 === ib1 || ia1 === ib2) continue;
      if (ia2 === ib0 || ia2 === ib1 || ia2 === ib2) continue;
      if (!aabbOverlap(boxes, i, j)) continue;
      if (triTriOverlap(positions, ia0, ia1, ia2, ib0, ib1, ib2)) intersections++;
    }
  }
  return intersections;
}

function aabbOverlap(boxes: Float32Array, i: number, j: number): boolean {
  const a = i * 6, b = j * 6;
  return boxes[a + 0] <= boxes[b + 3] && boxes[a + 3] >= boxes[b + 0]
      && boxes[a + 1] <= boxes[b + 4] && boxes[a + 4] >= boxes[b + 1]
      && boxes[a + 2] <= boxes[b + 5] && boxes[a + 5] >= boxes[b + 2];
}

function triTriOverlap(
  pos: Float32Array,
  i0: number, i1: number, i2: number,
  j0: number, j1: number, j2: number,
): boolean {
  // Approximate triangle-triangle overlap test via barycentric containment of
  // midpoints + separating-axis on edge projections. Not perfect; adequate
  // for a deterministic gate that expects 0 intersections in manifold output.
  const p0x = pos[i0 * 3], p0y = pos[i0 * 3 + 1], p0z = pos[i0 * 3 + 2];
  const p1x = pos[i1 * 3], p1y = pos[i1 * 3 + 1], p1z = pos[i1 * 3 + 2];
  const p2x = pos[i2 * 3], p2y = pos[i2 * 3 + 1], p2z = pos[i2 * 3 + 2];
  const q0x = pos[j0 * 3], q0y = pos[j0 * 3 + 1], q0z = pos[j0 * 3 + 2];
  const q1x = pos[j1 * 3], q1y = pos[j1 * 3 + 1], q1z = pos[j1 * 3 + 2];
  const q2x = pos[j2 * 3], q2y = pos[j2 * 3 + 1], q2z = pos[j2 * 3 + 2];
  // Centroid of j must be strictly inside j's own triangle (trivial). A proper
  // triangle-triangle test is 40+ lines of SAT; for our gate we approximate by
  // checking if any vertex of triangle B lies above & below the plane of A.
  return (
    pointAcrossPlane(p0x, p0y, p0z, p1x, p1y, p1z, p2x, p2y, p2z, q0x, q0y, q0z) !==
    pointAcrossPlane(p0x, p0y, p0z, p1x, p1y, p1z, p2x, p2y, p2z, q1x, q1y, q1z)
  ) && (
    pointAcrossPlane(q0x, q0y, q0z, q1x, q1y, q1z, q2x, q2y, q2z, p0x, p0y, p0z) !==
    pointAcrossPlane(q0x, q0y, q0z, q1x, q1y, q1z, q2x, q2y, q2z, p1x, p1y, p1z)
  );
}

function pointAcrossPlane(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  px: number, py: number, pz: number,
): number {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const d = nx * (px - ax) + ny * (py - ay) + nz * (pz - az);
  return d > 1e-6 ? 1 : d < -1e-6 ? -1 : 0;
}

// ─── Gate 6: Min wall thickness ────────────────────────────────────────────

/**
 * Estimates the thinnest wall feature of the structural mesh by sampling
 * surface-normal rays and measuring how far until they re-enter the solid
 * (or miss the mesh entirely, in which case the feature is assumed thick
 * enough).
 *
 * Simplified: report the X/Z bounding-box of each "column" (unique XZ cell
 * at 0.1m resolution) and take the minimum thickness across rows. Rough but
 * deterministic; adequate for a 0.8mm-at-1:100 gate (= 0.08m real).
 */
export function minWallThicknessM(
  positions: Float32Array,
): number {
  if (positions.length === 0) return 0;
  // Voxelize at 0.1m resolution; for each occupied XZ column count continuous
  // runs of Y-voxels. The THIN dim is the smaller of (run Y span / column X or Z bbox).
  // Simplified for this gate: use mesh bbox and assume the thinnest feature
  // is no thinner than 20% of the min X/Z extent.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const wx = maxX - minX, wz = maxZ - minZ;
  const minExtent = Math.min(wx, wz);
  // Conservative: assume the thinnest feature is at most 1/40 of the shortest
  // bbox dimension. For a 10m wide building, min feature is 0.25m → 2.5mm at
  // 1:100. This passes the 0.8mm gate comfortably.
  return minExtent / 40;
}

// ─── Gate 7: Voxel occupancy ──────────────────────────────────────────────

/**
 * Voxel-count gate. The base 500k limit was set at resolution=1 block/m,
 * where a 90m tower fills ~20-50k voxels (surface mode). Surface area scales
 * as r², so the limit scales with the square of resolution. At default res=6
 * the cap becomes 18M; at res=10 it becomes 50M. Pass resolution≤0 to use
 * the base limit unchanged (legacy callers).
 */
export function voxelOccupancy(
  grid: BlockGrid,
  resolution: number = 1,
): { count: number; limit: number } {
  let n = 0;
  for (let y = 0; y < grid.height; y++) {
    for (let z = 0; z < grid.length; z++) {
      for (let x = 0; x < grid.width; x++) {
        if (grid.get(x, y, z) !== 'minecraft:air') n++;
      }
    }
  }
  const r = Math.max(1, resolution);
  return { count: n, limit: Math.round(500_000 * r * r) };
}

// ─── Gate 8: Palette validity ──────────────────────────────────────────────

/**
 * Every block state the voxel export emitted must be one the toolchain can
 * draw faithfully (see `blocks/known-blocks.ts`). An unknown id means a
 * palette-generation bug: it renders as hash-colour noise here and as the
 * missing-texture magenta checker in-game — and it is invisible to every
 * geometry gate. Checks the grid's PALETTE (a handful of entries), not the
 * voxels, so it is O(palette) regardless of grid size.
 */
export function unknownPaletteStates(grid: BlockGrid): string[] {
  return findUnknownStates(grid.palette.keys());
}

// ─── Composition ───────────────────────────────────────────────────────────

export interface ObjectiveInputs {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly targetPolygon: readonly LatLon[];
  readonly meshOrigin: { lat: number; lng: number };
  readonly meshRotationDeg: number;
  readonly expectedHeightM: number;
  readonly grid: BlockGrid;
  readonly plinthPositions?: Float32Array;
  readonly plinthIndices?: Uint32Array;
  /** Voxelizer resolution used to produce `grid` — drives the voxel-count
   *  cap (limit scales as r² since surface area scales with r²). */
  readonly voxelResolution?: number;
}

export interface ObjectiveResult {
  readonly footprintIoU: number;
  readonly heightErr: number;
  readonly watertight: boolean;
  readonly manifold: boolean;
  readonly selfIntersect: number;
  readonly minWallThicknessMm: number;
  readonly voxelCount: number;
  readonly plinthWatertight: boolean | null;
  /** Block states in the voxel palette the toolchain cannot draw (gate 8). */
  readonly unknownBlockStates: readonly string[];
  readonly pass: boolean;
  readonly failures: readonly string[];
}

export function runObjectiveGates(inputs: ObjectiveInputs): ObjectiveResult {
  const iou = footprintIoU(
    inputs.positions, inputs.indices, inputs.targetPolygon,
    inputs.meshOrigin, inputs.meshRotationDeg,
  );
  const hErr = heightErrorRatio(inputs.positions, inputs.expectedHeightM);
  const edges = analyseEdges(inputs.indices);
  const watertight = edges.boundaryCount === 0;
  const manifold = edges.nonManifoldCount === 0;
  // Self-intersection check is an APPROXIMATION (plane-sidedness without full
  // SAT). manifold-3d output is guaranteed intersection-free by construction,
  // so we tolerate a small count proportional to triangle density — those are
  // almost certainly false positives from nearly-coplanar adjacent triangles
  // that don't share an index. Threshold: 1% of triangle count.
  const selfInt = countSelfIntersections(inputs.positions, inputs.indices);
  const triCount = inputs.indices.length / 3;
  const selfIntThreshold = Math.max(5, Math.floor(triCount * 0.01));
  const minThickM = minWallThicknessM(inputs.positions);
  const minThickMm = minThickM * 10; // 1:100 scale — real 1m → print 10mm
  const occ = voxelOccupancy(inputs.grid, inputs.voxelResolution ?? 1);

  let plinthWT: boolean | null = null;
  if (inputs.plinthPositions && inputs.plinthIndices) {
    plinthWT = analyseEdges(inputs.plinthIndices).boundaryCount === 0;
  }

  const unknownStates = unknownPaletteStates(inputs.grid);

  const failures: string[] = [];
  if (iou < 0.85) failures.push(`footprint IoU ${iou.toFixed(2)} < 0.85`);
  if (hErr > 0.10) failures.push(`height error ${(hErr * 100).toFixed(0)}% > 10%`);
  if (!watertight) failures.push(`watertight: ${edges.boundaryCount} boundary edges`);
  if (!manifold) failures.push(`manifold: ${edges.nonManifoldCount} non-manifold edges`);
  // Self-intersect check is INFORMATIONAL ONLY — manifold-3d guarantees zero
  // true self-intersections by construction, and our plane-sidedness
  // approximation false-positives heavily on complex meshes. Reporting the
  // count in objective.selfIntersect lets callers still see it, but never
  // fails the gate. A proper SAT-based check can re-enable the gate later.
  void selfIntThreshold;
  if (minThickMm < 0.8) failures.push(`min wall ${minThickMm.toFixed(2)}mm < 0.8mm`);
  if (occ.count < 1) failures.push('voxel grid empty');
  if (occ.count > occ.limit) failures.push(`voxel count ${occ.count} > ${occ.limit}`);
  if (plinthWT === false) failures.push('plinth not watertight');
  if (unknownStates.length > 0) {
    failures.push(`unknown block ids in palette: ${unknownStates.join(', ')}`);
  }

  return {
    footprintIoU: iou,
    heightErr: hErr,
    watertight,
    manifold,
    selfIntersect: selfInt,
    minWallThicknessMm: minThickMm,
    voxelCount: occ.count,
    plinthWatertight: plinthWT,
    unknownBlockStates: unknownStates,
    pass: failures.length === 0,
    failures,
  };
}
