/**
 * ENU (East-North-Up) reorientation for ECEF-tilted 3D tile meshes.
 *
 * Extracted from scripts/voxelize-glb.ts for reuse across CLI tools.
 *
 * Provides:
 *  - `reorientToENU()` — vertical tilt correction + horizontal alignment
 *  - `estimateUpDirection()` — PCA-based up-vector detection
 *  - `jacobi3x3()` — eigenvalue decomposition for 3x3 symmetric matrices
 *  - `HEADLESS_NORTH_ALIGN` — 180° Y-rotation constant for OBJECT_FRAME convention
 */

import * as THREE from 'three';
import type { BuildingAlignment } from '../convert/building-alignment.js';

// ─── North-Alignment for Headless GLBs ──────────────────────────────────────
//
// 3d-tiles-renderer's ReorientationPlugin uses OBJECT_FRAME which maps:
//   +X = West,  +Y = Up,  +Z = North
// (confirmed from Ellipsoid.js OBJECT_FRAME rotation: Euler(-π/2, 0, π, 'XYZ'))
//
// Our topdown renderer maps X→right, Z→down, so without correction:
//   right = West (should be East), down = North (should be South)
//
// Fix: rotate 180° around Y to negate both X and Z:
//   +X = East, +Z = South → right=East, down=South → north-up ✓
//
export const HEADLESS_NORTH_ALIGN = Math.PI; // 180° Y-rotation to fix OBJECT_FRAME convention

// ─── ENU Reorientation ──────────────────────────────────────────────────────

/**
 * Detect and correct ECEF-tilted meshes to local ENU (East-North-Up).
 *
 * Google 3D Tiles in ECEF have "up" pointing radially outward from Earth's
 * center. For a ~50m capture radius, the mesh cluster's center-of-mass
 * direction from origin approximates the local "up" vector. We rotate the
 * scene so that this direction aligns with Y+, producing correct Y-up
 * orientation for Minecraft voxelization.
 *
 * Detection heuristic: if Y extent >= 0.8 × max(X,Z) extent, the mesh is
 * likely ECEF-tilted (a flat neighborhood shouldn't be taller than it is wide).
 *
 * @returns The horizontal rotation angle (radians around Y axis) applied during
 *          alignment. Callers should store this value for downstream use (e.g.,
 *          rotating OSM polygons to match the grid after PCA alignment).
 *          Returns 0 if no horizontal rotation was applied.
 */
export function reorientToENU(
  scene: THREE.Group,
  skipHorizontalAlign = false,
  skipSnap = false,
  alignment?: BuildingAlignment,
): number {
  /** Tracks the horizontal rotation angle applied (radians around Y axis). */
  let horizontalAngle = 0;

  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);

  const maxXZ = Math.max(size.x, size.z);
  if (maxXZ < 0.01) return horizontalAngle; // Degenerate mesh

  // 1. Vertical alignment via PCA — detect tilt angle instead of brittle Y/XZ ratio.
  // PCA is cheap (~500 samples/mesh), so always compute it and check actual tilt.
  const { minEigenvector: upDir } = estimateUpDirection(scene);
  const targetUp = new THREE.Vector3(0, 1, 0);
  const tiltAngle = upDir.angleTo(targetUp);

  if (tiltAngle > 0.087) { // >5° tilt — apply vertical correction
    console.log(`ENU vertical align: correcting tilt of ${(tiltAngle * 180 / Math.PI).toFixed(1)}°`);
    const quat = new THREE.Quaternion().setFromUnitVectors(upDir, targetUp);
    const rotMatrix = new THREE.Matrix4().makeRotationFromQuaternion(quat);
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        child.geometry.applyMatrix4(rotMatrix);
      }
    });
  } else {
    console.log(`ENU vertical align: tilt is negligible (${(tiltAngle * 180 / Math.PI).toFixed(1)}°), skipping`);
  }

  // 2. Horizontal alignment via Minimum Bounding Box Area Sweep.
  // PCA longest-axis alignment rotates square buildings 45° (diagonal = longest axis).
  // Instead, sweep 0-90° in 1° steps and find the rotation that minimizes XZ bounding
  // box area. This correctly handles squares, rectangles, L-shapes, and pentagons.
  if (!skipHorizontalAlign) {
    if (alignment) {
      // v300: Exact rotation from OSM MBR — primary facade faces -Z.
      // Apply via geometry transform (consistent with PCA vertical alignment above).
      // Avoids quantization error from 1°-step sweep and prevents 90° snap flips.
      const yRotation = new THREE.Matrix4().makeRotationY(-alignment.rotationRad);
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh && child.geometry) {
          child.geometry.applyMatrix4(yRotation);
        }
      });
      horizontalAngle = alignment.rotationRad;
      console.log(`ENU horizontal align: exact OSM MBR rotation ${alignment.rotationDeg.toFixed(1)}° (skip sweep+snap)`);
    } else {
      // Fallback: angular sweep + 90° snap when no OSM alignment is available.
      const pointsXZ: { x: number; z: number }[] = [];
      scene.traverse((child) => {
        if (!(child instanceof THREE.Mesh) || !child.geometry) return;
        const posAttr = child.geometry.getAttribute('position') as THREE.BufferAttribute;
        if (!posAttr) return;
        const step = Math.max(1, Math.floor(posAttr.count / 500));
        for (let i = 0; i < posAttr.count; i += step) {
          pointsXZ.push({ x: posAttr.getX(i), z: posAttr.getZ(i) });
        }
      });

      if (pointsXZ.length > 10) {
        let bestAngle = 0;
        let minArea = Infinity;

        for (let deg = 0; deg < 90; deg += 1) {
          const rad = deg * Math.PI / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;

          for (const p of pointsXZ) {
            const rx = p.x * cos - p.z * sin;
            const rz = p.x * sin + p.z * cos;
            if (rx < mnX) mnX = rx;
            if (rx > mxX) mxX = rx;
            if (rz < mnZ) mnZ = rz;
            if (rz > mxZ) mxZ = rz;
          }

          const area = (mxX - mnX) * (mxZ - mnZ);
          if (area < minArea) {
            minArea = area;
            bestAngle = rad;
          }
        }

        // v71: Snap rotation to nearest 90° to axis-align building edges.
        // Diagonal edges create staircase aliasing at 1 block/m that makes
        // rectangles look like diamonds/ovals. Axis-aligned edges give crisp
        // straight lines visible in top-down plan views.
        // Snap to nearest 90° only when area increase is modest (< 50%).
        // PCA alignment minimizes bounding box by aligning walls with axes —
        // forcing 0°/90° when walls are at ~40° creates WORSE staircase aliasing.
        const optimalDeg = bestAngle * 180 / Math.PI;
        const snappedDeg = Math.round(optimalDeg / 90) * 90;
        const snappedRad = snappedDeg * Math.PI / 180;

        let useSnapped = false;
        if (skipSnap) {
          console.log(`ENU horizontal align: rotated ${optimalDeg.toFixed(1)}° (snap disabled — preserving real-world orientation)`);
        } else if (Math.abs(snappedRad - bestAngle) > 0.01) {
          const cos2 = Math.cos(snappedRad), sin2 = Math.sin(snappedRad);
          let mnX2 = Infinity, mxX2 = -Infinity, mnZ2 = Infinity, mxZ2 = -Infinity;
          for (const p of pointsXZ) {
            const rx = p.x * cos2 - p.z * sin2;
            const rz = p.x * sin2 + p.z * cos2;
            if (rx < mnX2) mnX2 = rx;
            if (rx > mxX2) mxX2 = rx;
            if (rz < mnZ2) mnZ2 = rz;
            if (rz > mxZ2) mxZ2 = rz;
          }
          const snappedArea = (mxX2 - mnX2) * (mxZ2 - mnZ2);
          if (snappedArea <= minArea * 1.5) {
            useSnapped = true;
            bestAngle = snappedRad;
            console.log(`ENU horizontal align: snapped ${optimalDeg.toFixed(1)}° → ${snappedDeg}° for axis-aligned edges (area +${((snappedArea / minArea - 1) * 100).toFixed(0)}%)`);
          } else {
            console.log(`ENU horizontal align: kept ${optimalDeg.toFixed(1)}° (snapping to ${snappedDeg}° would increase area by ${((snappedArea / minArea - 1) * 100).toFixed(0)}%)`);
          }
        }

        if (bestAngle > 0.01) {
          if (!useSnapped && !skipSnap) {
            console.log(`ENU horizontal align: rotated ${(bestAngle * 180 / Math.PI).toFixed(1)}° to minimize footprint`);
          }
          const yRotation = new THREE.Matrix4().makeRotationY(-bestAngle);
          scene.traverse((child) => {
            if (child instanceof THREE.Mesh && child.geometry) {
              child.geometry.applyMatrix4(yRotation);
            }
          });
          horizontalAngle = bestAngle; // Track for OSM polygon rotation
        }
      }
    }
  }

  // Recenter so ground is at Y=0, XZ centered at origin
  const newBox = new THREE.Box3().setFromObject(scene);
  const newSize = new THREE.Vector3();
  newBox.getSize(newSize);
  const shift = new THREE.Vector3(
    -(newBox.min.x + newSize.x / 2),
    -newBox.min.y,
    -(newBox.min.z + newSize.z / 2),
  );

  const shiftMatrix = new THREE.Matrix4().makeTranslation(shift.x, shift.y, shift.z);
  scene.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      child.geometry.applyMatrix4(shiftMatrix);
    }
  });

  const finalBox = new THREE.Box3().setFromObject(scene);
  const finalSize = new THREE.Vector3();
  finalBox.getSize(finalSize);
  console.log(`ENU result: ${finalSize.x.toFixed(1)} x ${finalSize.y.toFixed(1)} x ${finalSize.z.toFixed(1)} (Y/XZ: ${(finalSize.y / Math.max(finalSize.x, finalSize.z)).toFixed(2)})`);

  return horizontalAngle;
}

/**
 * Estimate the "up" direction of an ECEF mesh cluster using PCA.
 * The smallest principal component of the vertex positions corresponds
 * to the axis along which the data is flattest — i.e., the vertical axis
 * for a mostly-horizontal neighborhood capture.
 */
export function estimateUpDirection(scene: THREE.Group): { minEigenvector: THREE.Vector3 } {
  // Collect a sample of vertex positions (subsample for performance)
  const positions: THREE.Vector3[] = [];
  const center = new THREE.Vector3();

  scene.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.geometry) return;
    const posAttr = child.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!posAttr) return;
    const step = Math.max(1, Math.floor(posAttr.count / 500)); // ~500 samples per mesh
    for (let i = 0; i < posAttr.count; i += step) {
      const v = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      positions.push(v);
      center.add(v);
    }
  });

  if (positions.length < 10) return { minEigenvector: new THREE.Vector3(0, 1, 0) };

  center.divideScalar(positions.length);

  // Build 3x3 covariance matrix
  let cxx = 0, cxy = 0, cxz = 0;
  let cyy = 0, cyz = 0, czz = 0;

  for (const v of positions) {
    const dx = v.x - center.x;
    const dy = v.y - center.y;
    const dz = v.z - center.z;
    cxx += dx * dx; cxy += dx * dy; cxz += dx * dz;
    cyy += dy * dy; cyz += dy * dz; czz += dz * dz;
  }

  const n = positions.length;
  cxx /= n; cxy /= n; cxz /= n;
  cyy /= n; cyz /= n; czz /= n;

  // Find eigenvector with smallest eigenvalue via power iteration on inverse
  // (or equivalently, find the axis of minimum variance).
  // Simple approach: try each axis-aligned candidate and pick the one that
  // produces the minimum projected variance. For ECEF data the tilt is
  // typically 30-50° off any axis, so we use iterative refinement.
  //
  // Jacobi eigenvalue algorithm for 3x3 symmetric matrix:
  const eigenvectors = jacobi3x3(cxx, cxy, cxz, cyy, cyz, czz);

  // Return the eigenvector with smallest eigenvalue (flattest direction = "up")
  // and the largest eigenvalue (longest horizontal extent for XZ alignment)
  return eigenvectors;
}

/**
 * Jacobi eigenvalue decomposition for a 3x3 symmetric matrix.
 * Returns eigenvectors sorted by eigenvalue (ascending).
 */
export function jacobi3x3(
  a11: number, a12: number, a13: number,
  a22: number, a23: number, a33: number,
): { minEigenvector: THREE.Vector3 } {
  // Matrix A stored as flat array (symmetric, row-major)
  const a = [a11, a12, a13, a12, a22, a23, a13, a23, a33];
  // Eigenvector matrix V starts as identity
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  // Jacobi rotation iterations
  for (let iter = 0; iter < 50; iter++) {
    // Find largest off-diagonal element
    let maxVal = 0;
    let p = 0, q = 1;
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const val = Math.abs(a[i * 3 + j]);
        if (val > maxVal) { maxVal = val; p = i; q = j; }
      }
    }
    if (maxVal < 1e-10) break; // Converged

    // Compute rotation angle
    const app = a[p * 3 + p], aqq = a[q * 3 + q], apq = a[p * 3 + q];
    const theta = 0.5 * Math.atan2(2 * apq, app - aqq);
    const c = Math.cos(theta), s = Math.sin(theta);

    // Rotate A: A' = G^T * A * G
    const newA = [...a];
    newA[p * 3 + p] = c * c * app + 2 * s * c * apq + s * s * aqq;
    newA[q * 3 + q] = s * s * app - 2 * s * c * apq + c * c * aqq;
    newA[p * 3 + q] = 0;
    newA[q * 3 + p] = 0;

    for (let r = 0; r < 3; r++) {
      if (r === p || r === q) continue;
      const arp = a[r * 3 + p], arq = a[r * 3 + q];
      newA[r * 3 + p] = c * arp + s * arq;
      newA[p * 3 + r] = newA[r * 3 + p];
      newA[r * 3 + q] = -s * arp + c * arq;
      newA[q * 3 + r] = newA[r * 3 + q];
    }
    for (let i = 0; i < 9; i++) a[i] = newA[i];

    // Update eigenvectors: V' = V * G
    const newV = [...v];
    for (let r = 0; r < 3; r++) {
      const vrp = v[r * 3 + p], vrq = v[r * 3 + q];
      newV[r * 3 + p] = c * vrp + s * vrq;
      newV[r * 3 + q] = -s * vrp + c * vrq;
    }
    for (let i = 0; i < 9; i++) v[i] = newV[i];
  }

  // Eigenvalues are on diagonal of A
  const eigenvalues = [a[0], a[4], a[8]];

  // Sort indices by eigenvalue ascending (min first)
  const sortedIdx = [0, 1, 2].sort((ia, ib) => eigenvalues[ia] - eigenvalues[ib]);
  const minIdx = sortedIdx[0];

  // Min eigenvector (up direction — flattest axis)
  const ev = new THREE.Vector3(v[0 * 3 + minIdx], v[1 * 3 + minIdx], v[2 * 3 + minIdx]);
  ev.normalize();
  if (ev.y < 0) ev.negate();

  console.log(`PCA eigenvalues: [${eigenvalues.map(e => e.toFixed(1)).join(', ')}], min axis index: ${minIdx}`);
  return { minEigenvector: ev };
}
