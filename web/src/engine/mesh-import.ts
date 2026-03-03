/**
 * Mesh file loaders for browser — GLB/GLTF/OBJ → Three.js Object3D.
 * Loaders are dynamically imported to keep them out of the main bundle.
 */

import * as THREE from 'three';

/** Supported mesh file types */
export type MeshType = 'glb' | 'gltf' | 'obj';

/** Mesh metadata for UI display */
export interface MeshInfo {
  triangleCount: number;
  vertexCount: number;
  meshCount: number;
  boundingBox: { width: number; height: number; depth: number };
  hasTextures: boolean;
}

/** Detect mesh type from filename extension */
export function detectMeshType(filename: string): MeshType | null {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'glb': return 'glb';
    case 'gltf': return 'gltf';
    case 'obj': return 'obj';
    default: return null;
  }
}

/**
 * Load GLB/GLTF/OBJ from raw bytes into a Three.js Object3D.
 * Loaders are dynamically imported to keep bundle size down.
 */
export async function loadMeshFromBytes(
  bytes: ArrayBuffer,
  filename: string,
): Promise<THREE.Object3D> {
  const type = detectMeshType(filename);
  if (!type) throw new Error(`Unsupported mesh format: ${filename}`);

  switch (type) {
    case 'glb':
    case 'gltf': {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      return new Promise<THREE.Object3D>((resolve, reject) => {
        loader.parse(bytes, '', (gltf) => {
          resolve(gltf.scene);
        }, (error) => {
          reject(new Error(`GLTF parse error: ${error}`));
        });
      });
    }
    case 'obj': {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
      const loader = new OBJLoader();
      // OBJLoader.parse takes a string, not ArrayBuffer
      const text = new TextDecoder().decode(bytes);
      const group = loader.parse(text);
      // OBJ files may use Z-up coordinates; normalize to Y-up
      normalizeToYUp(group);
      return group;
    }
  }
}

/** Analyze mesh metadata for UI display */
export function analyzeMesh(object: THREE.Object3D): MeshInfo {
  let triangleCount = 0;
  let vertexCount = 0;
  let meshCount = 0;
  let hasTextures = false;

  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      meshCount++;
      const geo = child.geometry;
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

  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);

  return {
    triangleCount: Math.round(triangleCount),
    vertexCount,
    meshCount,
    boundingBox: { width: +size.x.toFixed(2), height: +size.y.toFixed(2), depth: +size.z.toFixed(2) },
    hasTextures,
  };
}

/**
 * Detect and fix Z-up coordinate system (common in OBJ files).
 * If the model appears to use Z-up (taller in Z than Y), rotate -90 around X.
 */
function normalizeToYUp(object: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);

  // Heuristic: if Z extent > 2 * Y extent, likely Z-up
  if (size.z > size.y * 2 && size.y < size.x) {
    object.rotation.x = -Math.PI / 2;
    object.updateMatrixWorld(true);
  }
}
