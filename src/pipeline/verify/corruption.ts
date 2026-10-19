/**
 * Deterministic corruption toolkit for the objective-gate self-test.
 *
 * Adapted from Tekton's `demo:corrupt` / `demo:restore` gate proof: a verifier
 * is only trustworthy if a deliberately-broken-but-plausible output makes it
 * refuse. The objective gates (`./objective.ts`) are unit-tested on toy meshes
 * (a tetrahedron, an open shell) — which proves the gate functions, not that it
 * catches a regression in a building-shaped output. These helpers instead
 * perturb a REAL synthesized building mesh in the exact ways the pipeline fails
 * in the field, so the self-test (`./corruption.test.ts`) proves each gate has
 * teeth on real geometry.
 *
 * Each corruption maps to one production failure mode and the gate that must
 * catch it:
 *
 *   crushHeight     height_truncated          → height-error gate
 *   shiftFootprint  footprint mis-registered   → footprint-IoU gate
 *   mergeNeighbour  neighbor_buildings_merged  → footprint-IoU gate
 *   punctureMesh    facade_holes_visible       → watertight gate
 *
 * All functions are PURE: they return fresh typed arrays and never mutate the
 * input, so the same clean baseline can be reused as the "restore" beat.
 *
 * Mesh arrays are the `EvaluatedMesh` convention: `positions` is a flat
 * `[x0,y0,z0, x1,y1,z1, ...]` Float32Array in metres (Y-up), `indices` is a flat
 * Uint32Array, 3 vertex indices per triangle.
 */

/** The subset of `EvaluatedMesh` the gates and corruptions operate on. */
export interface MeshArrays {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

/**
 * Vertically compress the mesh by `factor` about its floor (e.g. `0.55` keeps
 * 55% of the height), simulating Google-3D-Tiles LOD truncation of a tall
 * building. Topology is preserved (watertight/manifold stay intact) so the
 * corruption isolates the height-error gate.
 */
export function crushHeight(mesh: MeshArrays, factor: number): MeshArrays {
  const positions = Float32Array.from(mesh.positions);
  let minY = Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    if (positions[i] < minY) minY = positions[i];
  }
  for (let i = 1; i < positions.length; i += 3) {
    positions[i] = minY + (positions[i] - minY) * factor;
  }
  return { positions, indices: Uint32Array.from(mesh.indices) };
}

/**
 * Translate the whole mesh in the local ground plane by `dxM`/`dzM` metres,
 * simulating a footprint that no longer registers to its target polygon
 * (mis-projection, wrong centroid). Topology is preserved, so this isolates the
 * footprint-IoU gate.
 */
export function shiftFootprint(mesh: MeshArrays, dxM: number, dzM: number): MeshArrays {
  const positions = Float32Array.from(mesh.positions);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += dxM;
    positions[i + 2] += dzM;
  }
  return { positions, indices: Uint32Array.from(mesh.indices) };
}

/**
 * Append a translated duplicate of the mesh `offsetXM` metres away — a second
 * closed solid that roughly doubles the top-down silhouette. Models a merged
 * neighbour building: every component stays watertight, but the footprint-IoU
 * against the single target polygon collapses (intersection ≈ one building,
 * union ≈ two). Isolates the footprint-IoU gate from the watertight gate.
 */
export function mergeNeighbour(mesh: MeshArrays, offsetXM: number): MeshArrays {
  const baseLen = mesh.positions.length;
  const vCount = baseLen / 3;
  const positions = new Float32Array(baseLen * 2);
  positions.set(mesh.positions, 0);
  for (let i = 0; i < baseLen; i += 3) {
    positions[baseLen + i] = mesh.positions[i] + offsetXM;
    positions[baseLen + i + 1] = mesh.positions[i + 1];
    positions[baseLen + i + 2] = mesh.positions[i + 2];
  }
  const indices = new Uint32Array(mesh.indices.length * 2);
  indices.set(mesh.indices, 0);
  for (let i = 0; i < mesh.indices.length; i++) {
    indices[mesh.indices.length + i] = mesh.indices[i] + vCount;
  }
  return { positions, indices };
}

/**
 * Remove `nTriangles` faces, opening boundary edges — a punctured facade / hole.
 * Drops evenly-spaced (non-adjacent) triangles so each leaves its own boundary
 * edges rather than merging into one large hole, guaranteeing the watertight
 * gate sees a non-zero boundary count. `manifold` stays true (removing a face
 * only drops shared edges from 2→1, never raises any above 2).
 */
export function punctureMesh(mesh: MeshArrays, nTriangles: number): MeshArrays {
  const triTotal = mesh.indices.length / 3;
  const drop = new Set<number>();
  const stride = Math.max(1, Math.floor(triTotal / (nTriangles + 1)));
  for (let k = 1; k <= nTriangles && k * stride < triTotal; k++) {
    drop.add(k * stride);
  }
  const kept: number[] = [];
  for (let t = 0; t < triTotal; t++) {
    if (drop.has(t)) continue;
    kept.push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]);
  }
  return {
    positions: Float32Array.from(mesh.positions),
    indices: Uint32Array.from(kept),
  };
}
