/**
 * STL / OBJ export validation (3D-printing path) — offline, GPU-free.
 *
 * The exporters bake one Mesh per InstancedMesh instance (Three's exporters
 * don't handle InstancedMesh) at real-world mm scale, so prints come out at
 * true LEGO size. These tests run the pure cores (meshesToStlBinary /
 * meshesToObj) on synthetic InstancedMeshes and validate the binary STL
 * structure, OBJ face counts, triangle conservation across instances, and the
 * real-world scale. (GLB structure is validated live; GLTFExporter's async
 * parse isn't worth a node harness.)
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  meshesToStlBinary,
  meshesToObj,
  countExportTriangles,
  EXPORT_MM_PER_STUD,
  type ExportMeshLike,
} from '../web/src/viewer/exporter.js';

/** A unit cube InstancedMesh stand-in: BoxGeometry (12 tris) + N instance matrices. */
function cubeInstances(positions: [number, number, number][]): ExportMeshLike {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const originalMatrices = positions.map(([x, y, z]) =>
    new THREE.Matrix4().makeTranslation(x, y, z));
  return {
    geometry,
    material: new THREE.MeshStandardMaterial(),
    userData: { originalMatrices },
  };
}

describe('countExportTriangles', () => {
  it('sums per-part triangles × instance count', () => {
    const a = cubeInstances([[0, 0, 0], [2, 0, 0], [4, 0, 0]]); // 3 × 12
    const b = cubeInstances([[0, 4, 0]]);                       // 1 × 12
    expect(countExportTriangles([a, b])).toBe(48);
  });

  it('ignores meshes without originalMatrices', () => {
    const noInst: ExportMeshLike = {
      geometry: new THREE.BoxGeometry(1, 1, 1),
      material: new THREE.MeshStandardMaterial(),
      userData: {},
    };
    expect(countExportTriangles([noInst])).toBe(0);
  });
});

describe('meshesToStlBinary', () => {
  it('produces a valid binary STL: 84 + 50·tris bytes, header tri-count = geometry', async () => {
    const meshes = [cubeInstances([[0, 0, 0], [3, 0, 0]])]; // 2 cubes = 24 tris
    const buf = await meshesToStlBinary(meshes);
    const view = new DataView(buf);
    const triCount = view.getUint32(80, true);
    expect(triCount).toBe(24);
    expect(buf.byteLength).toBe(84 + 24 * 50);
    expect(triCount).toBe(countExportTriangles(meshes));
  });

  it('bakes at real-world mm scale (8 mm/stud)', async () => {
    // One unit cube at origin → with scale 8, spans 8 mm. Read the first
    // triangle's vertices (STL: per-tri = normal[3] + 3×vertex[3] floats @ offset 84+12).
    const buf = await meshesToStlBinary([cubeInstances([[0, 0, 0]])]);
    const view = new DataView(buf);
    let maxAbs = 0;
    const triCount = view.getUint32(80, true);
    for (let t = 0; t < triCount; t++) {
      const base = 84 + t * 50 + 12; // skip 80 header + 4 count + 12 normal
      for (let i = 0; i < 9; i++) maxAbs = Math.max(maxAbs, Math.abs(view.getFloat32(base + i * 4, true)));
    }
    // Unit cube spans [-0.5, 0.5]; ×8 → [-4, 4] mm. Max coord ≈ 4.
    expect(maxAbs).toBeCloseTo(EXPORT_MM_PER_STUD / 2, 3);
  });

  it('scale=1 keeps scene units (unit cube → ±0.5)', async () => {
    const buf = await meshesToStlBinary([cubeInstances([[0, 0, 0]])], 1);
    const view = new DataView(buf);
    let maxAbs = 0;
    for (let t = 0; t < 12; t++) {
      const base = 84 + t * 50 + 12;
      for (let i = 0; i < 9; i++) maxAbs = Math.max(maxAbs, Math.abs(view.getFloat32(base + i * 4, true)));
    }
    expect(maxAbs).toBeCloseTo(0.5, 4);
  });
});

describe('meshesToObj', () => {
  it('produces OBJ with faces = total triangles (conserved across instances)', async () => {
    const meshes = [cubeInstances([[0, 0, 0], [3, 0, 0], [6, 0, 0]])]; // 3 cubes = 36 tris
    const obj = await meshesToObj(meshes);
    const faces = (obj.match(/^f /gm) ?? []).length;
    const verts = (obj.match(/^v /gm) ?? []).length;
    expect(faces).toBe(36); // triangle conservation — the real invariant
    // Indexed BoxGeometry shares 24 verts/cube; non-indexed real parts give 3×.
    // Either way each cube contributes its own vertices (no cross-mesh welding).
    expect(verts).toBe(3 * 24);
  });

  it('bakes at real-world mm scale (vertices reach ±4 mm for a unit cube)', async () => {
    const obj = await meshesToObj([cubeInstances([[0, 0, 0]])]);
    const coords = [...obj.matchAll(/^v (\S+) (\S+) (\S+)/gm)]
      .flatMap(m => [+m[1], +m[2], +m[3]]);
    const maxAbs = Math.max(...coords.map(Math.abs));
    expect(maxAbs).toBeCloseTo(EXPORT_MM_PER_STUD / 2, 3);
  });
});
