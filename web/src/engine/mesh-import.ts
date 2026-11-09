/**
 * Mesh file loaders for browser: GLB/GLTF/OBJ/STL/3MF/PLY -> Three.js Object3D, plus unit handling.
 * Loaders are dynamically imported to keep them out of the main bundle.
 *
 * Units (BIZ-32): 1 stud = 8 mm = 20 LDU, so mm x 2.5 = LDU. STL/PLY/3MF are millimetres by
 * convention (3MF states its unit), glTF is metres by spec, OBJ has no unit (millimetres is a guess,
 * flagged `guessed`). The UI can override with "real size", "fit to N studs" or an explicit scale
 * ({@link MeshSizing}). STL/PLY/3MF are Z-up (printer frame); they are baked to Y-up on load.
 */

import * as THREE from 'three';
import { read3mf } from './mesh-3mf.js';

/** Supported mesh file types */
export type MeshType = 'glb' | 'gltf' | 'obj' | 'stl' | '3mf' | 'ply';

/** LDU per millimetre (1 stud = 8 mm = 20 LDU). */
export const LDU_PER_MM = 2.5;

/** Mesh metadata for UI display */
export interface MeshInfo {
  triangleCount: number;
  vertexCount: number;
  meshCount: number;
  boundingBox: { width: number; height: number; depth: number };
  hasTextures: boolean;
}

/** What the file says (or we assume) about its length unit; stored in `object.userData.meshSource`. */
export interface MeshSource {
  type: MeshType;
  /** Metres in one file unit. */
  metresPerUnit: number;
  /** True when the unit is an assumption (OBJ), so the UI should offer "fit to N studs" first. */
  guessed: boolean;
  warnings: string[];
}

/** How a mesh is scaled to LDU. */
export type MeshSizing =
  | { mode: 'real' }
  | { mode: 'fit'; studs: number }
  | { mode: 'scale'; lduPerUnit: number };

/** Metres per unit for the 3MF `unit` attribute. */
const THREEMF_UNITS: Record<string, number> = {
  micron: 1e-6, millimeter: 1e-3, centimeter: 1e-2, inch: 0.0254, foot: 0.3048, meter: 1,
};

/** Detect mesh type from filename extension */
export function detectMeshType(filename: string): MeshType | null {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'glb': return 'glb';
    case 'gltf': return 'gltf';
    case 'obj': return 'obj';
    case 'stl': return 'stl';
    case '3mf': return '3mf';
    case 'ply': return 'ply';
    default: return null;
  }
}

/** Which compression extensions a glTF/GLB needs; the decoders are only loaded when true. */
export function gltfCompression(bytes: ArrayBuffer): { draco: boolean; meshopt: boolean } {
  const none = { draco: false, meshopt: false };
  const u8 = new Uint8Array(bytes);
  let json: string;
  if (u8.length >= 20 && new DataView(bytes).getUint32(0, true) === 0x46546c67) {
    // GLB: the first chunk is JSON.
    const len = new DataView(bytes).getUint32(12, true);
    if (20 + len > u8.length) return none;
    json = new TextDecoder().decode(u8.subarray(20, 20 + len));
  } else {
    json = new TextDecoder().decode(u8);
  }
  try {
    const doc = JSON.parse(json) as { extensionsUsed?: string[]; extensionsRequired?: string[] };
    const ext = new Set([...(doc.extensionsUsed ?? []), ...(doc.extensionsRequired ?? [])]);
    return { draco: ext.has('KHR_draco_mesh_compression'), meshopt: ext.has('EXT_meshopt_compression') };
  } catch {
    return none;
  }
}

/** Vendored Draco decoder (copied from three examples into web/public/vendor/draco); relative to the page. */
export const DRACO_DECODER_PATH = './vendor/draco/';

/** Rotate Z-up (STL/PLY/3MF) to Y-up: an axis swap only, the part is not moved onto the floor. */
function zUpToYUp(object: THREE.Object3D): void {
  object.updateMatrixWorld(true);
  const rot = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  object.traverse((c) => {
    if (c instanceof THREE.Mesh) c.geometry.applyMatrix4(rot);
  });
  object.updateMatrixWorld(true);
}

function tag(object: THREE.Object3D, type: MeshType, metresPerUnit: number, guessed: boolean, warnings: string[] = []): void {
  const src: MeshSource = { type, metresPerUnit, guessed, warnings };
  object.userData.meshSource = src;
}

/** Wraps one geometry (STL / PLY) as a Group with a default material, honouring vertex colours. */
function groupOfGeometry(geo: THREE.BufferGeometry): THREE.Group {
  const hasColour = !!geo.getAttribute('color');
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xcccccc, vertexColors: hasColour, side: THREE.DoubleSide })));
  return g;
}

/**
 * Load GLB/GLTF/OBJ/STL/3MF/PLY from raw bytes into a Three.js Object3D.
 * `object.userData.meshSource` records the unit assumption ({@link MeshSource}).
 * @throws on an unsupported or unreadable file, with a reason for the UI.
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
      const need = gltfCompression(bytes);
      let draco: { dispose(): void } | undefined;
      if (need.draco) {
        // Lazy: the decoder (~250 KB wasm) is only fetched for a file that needs it.
        const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js');
        const d = new DRACOLoader();
        d.setDecoderPath(DRACO_DECODER_PATH);
        loader.setDRACOLoader(d);
        draco = d;
      }
      if (need.meshopt) {
        const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');
        await MeshoptDecoder.ready;
        loader.setMeshoptDecoder(MeshoptDecoder);
      }
      try {
        const scene = await new Promise<THREE.Object3D>((resolve, reject) => {
          loader.parse(bytes, '', (gltf) => resolve(gltf.scene), (error) => {
            reject(new Error(`GLTF parse error: ${error instanceof Error ? error.message : String(error)}`));
          });
        });
        tag(scene, type, 1, false);
        return scene;
      } finally {
        draco?.dispose();
      }
    }
    case 'obj': {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
      const loader = new OBJLoader();
      // OBJLoader.parse takes a string, not ArrayBuffer
      const text = new TextDecoder().decode(bytes);
      const group = loader.parse(text);
      // OBJ files may use Z-up coordinates; normalize to Y-up
      normalizeToYUp(group);
      tag(group, type, 1e-3, true); // OBJ has no unit: millimetres is a guess
      return group;
    }
    case 'stl': {
      const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
      const geo = new STLLoader().parse(bytes);
      if (!geo.getAttribute('position') || geo.getAttribute('position').count < 3) throw new Error('STL has no triangles');
      const g = groupOfGeometry(geo);
      zUpToYUp(g);
      tag(g, type, 1e-3, false);
      return g;
    }
    case 'ply': {
      const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
      const geo = new PLYLoader().parse(bytes);
      // PLYLoader gives a point cloud (no index) when the file has no faces; a face-bearing file is indexed.
      if (!geo.getIndex()) throw new Error('PLY has no faces (a point cloud cannot be turned into bricks)');
      const g = groupOfGeometry(geo);
      zUpToYUp(g);
      tag(g, type, 1e-3, false);
      return g;
    }
    case '3mf': {
      const { group, unit, warnings } = read3mf(bytes);
      zUpToYUp(group);
      tag(group, type, THREEMF_UNITS[unit] ?? 1e-3, !(unit in THREEMF_UNITS), warnings);
      return group;
    }
  }
}

/** Unit info for a loaded mesh; objects not loaded here are treated as metres (glTF convention). */
export function meshSourceOf(object: THREE.Object3D): MeshSource {
  return (object.userData.meshSource as MeshSource | undefined)
    ?? { type: 'glb', metresPerUnit: 1, guessed: true, warnings: [] };
}

/** LDU per file unit for a sizing choice. @throws on a non-positive request. */
export function resolveLduPerUnit(object: THREE.Object3D, sizing: MeshSizing): number {
  switch (sizing.mode) {
    case 'real':
      return meshSourceOf(object).metresPerUnit * 1000 * LDU_PER_MM;
    case 'scale':
      if (!(sizing.lduPerUnit > 0)) throw new Error('scale must be positive');
      return sizing.lduPerUnit;
    case 'fit': {
      if (!(sizing.studs > 0)) throw new Error('fit needs studs > 0');
      const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
      const longest = Math.max(size.x, size.y, size.z);
      if (!(longest > 0)) throw new Error('mesh has no extent to fit');
      return (sizing.studs * 20) / longest; // largest side = N studs of 20 LDU
    }
  }
}

/** Extent in LDU (x, y up, z) under a sizing choice, plus the scale used. */
export function meshExtentLdu(object: THREE.Object3D, sizing: MeshSizing): { x: number; y: number; z: number; lduPerUnit: number } {
  const lduPerUnit = resolveLduPerUnit(object, sizing);
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  return { x: size.x * lduPerUnit, y: size.y * lduPerUnit, z: size.z * lduPerUnit, lduPerUnit };
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
