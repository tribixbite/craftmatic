/**
 * Mesh analysis utilities for GLB voxelization pipeline.
 *
 * - analyzeMeshes(): Collect mesh stats (vertex/triangle counts, textures, bounding box)
 * - analyzeOne(): Full single-GLB analysis pipeline for batch mode
 */

import * as THREE from 'three';
import { loadGLB } from './glb-loader.js';
import { reorientToENU } from './enu-orient.js';
import { filterMeshesByHeight, trimSparseBottomLayers, analyzeGrid } from '../convert/mesh-filter.js';
import { threeToGrid, createDataTextureSampler } from '../convert/voxelizer.js';
import { basename, extname } from 'node:path';

/** Collect mesh stats for --info output */
export function analyzeMeshes(object: THREE.Object3D): {
  meshCount: number;
  vertexCount: number;
  triangleCount: number;
  hasTextures: boolean;
  boundingBox: THREE.Box3;
} {
  let meshCount = 0;
  let vertexCount = 0;
  let triangleCount = 0;
  let hasTextures = false;

  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      meshCount++;
      const geo = child.geometry as THREE.BufferGeometry;
      if (geo.index) {
        triangleCount += geo.index.count / 3;
      } else if (geo.attributes.position) {
        triangleCount += geo.attributes.position.count / 3;
      }
      if (geo.attributes.position) {
        vertexCount += geo.attributes.position.count;
      }
      const mat = child.material as THREE.MeshStandardMaterial;
      if (mat?.map) hasTextures = true;
    }
  });

  const boundingBox = new THREE.Box3().setFromObject(object);

  return { meshCount, vertexCount, triangleCount: Math.round(triangleCount), hasTextures, boundingBox };
}

/** Analyze a single GLB and return summary row for batch mode. */
export async function analyzeOne(filepath: string, resolution: number, minHeight: number, trimThreshold: number, gamma: number, kernel: number, desaturate: number): Promise<{
  name: string; dims: string; blocks: number; type: string;
  conf: number; entry: string; footprint: number; front: string;
} | null> {
  try {
    const scene = await loadGLB(filepath);
    reorientToENU(scene);

    // Collect and filter meshes
    const candidates: Array<{ child: THREE.Mesh; worldBox: THREE.Box3 }> = [];
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.geometry) return;
      child.updateWorldMatrix(true, false);
      child.geometry.computeBoundingBox();
      const localBox = child.geometry.boundingBox;
      if (!localBox) return;
      const worldBox = localBox.clone().applyMatrix4(child.matrixWorld);
      candidates.push({ child, worldBox });
    });
    const { kept } = filterMeshesByHeight(candidates, minHeight);
    if (kept.length === 0) return null;

    // Clone meshes with baked world transforms into a clean group
    // (avoids setFromObject crash on raw glTF child nodes lacking updateWorldMatrix)
    const group = new THREE.Group();
    for (const { child } of kept) {
      const cloned = child.clone();
      cloned.applyMatrix4(child.matrixWorld);
      cloned.position.set(0, 0, 0);
      cloned.rotation.set(0, 0, 0);
      cloned.scale.set(1, 1, 1);
      cloned.updateMatrix();
      group.add(cloned);
    }

    const grid = threeToGrid(group, resolution, {
      mode: 'surface',
      textureSampler: createDataTextureSampler(gamma, kernel, desaturate),
    });
    const trimmed = trimSparseBottomLayers(grid, trimThreshold);
    const analysis = analyzeGrid(trimmed);
    const stem = basename(filepath, extname(filepath)).replace(/^tiles-/, '');

    return {
      name: stem.length > 30 ? stem.slice(0, 27) + '...' : stem,
      dims: `${trimmed.width}x${trimmed.height}x${trimmed.length}`,
      blocks: trimmed.countNonAir(),
      type: analysis.typology,
      conf: analysis.confidence,
      entry: analysis.entryPosition ? `(${analysis.entryPosition.x},${analysis.entryPosition.z}) w${analysis.entryWidth} p${analysis.entryPath.length}` : '-',
      footprint: analysis.footprintArea,
      front: analysis.frontFace,
    };
  } catch (err) {
    const stem = basename(filepath, extname(filepath)).replace(/^tiles-/, '');
    console.error(`  [ERROR] ${stem}: ${err}`);
    return null;
  }
}
