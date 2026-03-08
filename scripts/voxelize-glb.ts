/**
 * CLI standalone GLB → .schem voxelizer.
 *
 * Reads a previously-saved GLB file (from the browser tiles pipeline),
 * runs the voxelizer with configurable params, and writes a .schem file.
 * No API calls — iterate on parameters until the output is clean.
 *
 * Usage:
 *   bun scripts/voxelize-glb.ts <input.glb> [options]
 *
 * Options:
 *   --resolution, -r   Blocks per meter (default: 1)
 *   --mode, -m         solid | surface (default: surface)
 *   --min-height       Min mesh height above ground to keep, meters (default: 2)
 *   --trim             Bottom-layer trim fill threshold, 0-1 (default: 0.05)
 *   --output, -o       Output .schem path (default: <input-stem>.schem)
 *   --info             Print mesh stats and exit (no voxelize)
 */

// Polyfill browser APIs that Three.js FileLoader expects in headless Bun
if (typeof globalThis.ProgressEvent === 'undefined') {
  (globalThis as Record<string, unknown>).ProgressEvent = class ProgressEvent extends Event {
    readonly lengthComputable: boolean;
    readonly loaded: number;
    readonly total: number;
    constructor(type: string, init?: { lengthComputable?: boolean; loaded?: number; total?: number }) {
      super(type);
      this.lengthComputable = init?.lengthComputable ?? false;
      this.loaded = init?.loaded ?? 0;
      this.total = init?.total ?? 0;
    }
  };
}

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { threeToGrid, createDataTextureSampler } from '../src/convert/voxelizer.js';
import type { VoxelizeMode } from '../src/convert/voxelizer.js';
import { filterMeshesByHeight, trimSparseBottomLayers, smoothRareBlocks, modeFilter3D, constrainPalette, fillInteriorGaps, solidifyCore, carveFacadeShadows } from '../src/convert/mesh-filter.js';
import { writeSchematic } from '../src/schem/write.js';
import { basename, extname, join, dirname } from 'node:path';

// ─── CLI Argument Parsing ───────────────────────────────────────────────────

interface CLIArgs {
  inputPath: string;
  resolution: number;
  mode: VoxelizeMode;
  minHeight: number;
  trimThreshold: number;
  gamma: number;
  kernel: number;
  desaturate: number;
  outputPath: string;
  infoOnly: boolean;
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: bun scripts/voxelize-glb.ts <input.glb> [options]

Options:
  --resolution, -r   Blocks per meter (default: 1)
  --mode, -m         solid | surface (default: surface)
  --min-height       Min mesh height above ground to keep (default: 2)
  --trim             Bottom-layer trim fill threshold (default: 0.05)
  --gamma, -g        Brightness correction gamma (default: 0.5, <1 brightens baked-lighting tiles)
  --kernel, -k       Texture averaging kernel radius in pixels (default: 16, 0=point sampling)
  --desaturate       Saturation reduction 0-1 to neutralize blue shadows (default: 0.65)
  --output, -o       Output .schem path (default: <input-stem>.schem)
  --info             Print mesh stats and exit (no voxelize)`);
    process.exit(0);
  }

  // First non-flag arg is the input path
  let inputPath = '';
  let resolution = 1;
  let mode: VoxelizeMode = 'surface';
  let minHeight = 2;
  let trimThreshold = 0.05;
  let gamma = 0.5; // Google 3D Tiles have baked lighting — 0.5 gamma compensates
  let kernel = 16; // Large kernel for Google 3D Tiles texture density
  let desaturate = 0.65; // Neutralize blue sky shadows baked into textures
  let outputPath = '';
  let infoOnly = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--resolution' || arg === '-r') {
      resolution = parseFloat(args[++i]);
    } else if (arg === '--mode' || arg === '-m') {
      mode = args[++i] as VoxelizeMode;
    } else if (arg === '--min-height') {
      minHeight = parseFloat(args[++i]);
    } else if (arg === '--trim') {
      trimThreshold = parseFloat(args[++i]);
    } else if (arg === '--gamma' || arg === '-g') {
      gamma = parseFloat(args[++i]);
    } else if (arg === '--kernel' || arg === '-k') {
      kernel = parseInt(args[++i], 10);
    } else if (arg === '--desaturate') {
      desaturate = parseFloat(args[++i]);
    } else if (arg === '--output' || arg === '-o') {
      outputPath = args[++i];
    } else if (arg === '--info') {
      infoOnly = true;
    } else if (!arg.startsWith('-')) {
      inputPath = arg;
    }
  }

  if (!inputPath) {
    console.error('Error: no input GLB file specified');
    process.exit(1);
  }

  if (!outputPath) {
    const stem = basename(inputPath, extname(inputPath));
    outputPath = join(dirname(inputPath), `${stem}.schem`);
  }

  return { inputPath, resolution, mode, minHeight, trimThreshold, gamma, kernel, desaturate, outputPath, infoOnly };
}

// ─── GLB Loading ────────────────────────────────────────────────────────────

/** Load a GLB file from disk into a Three.js scene, decoding embedded textures. */
async function loadGLB(filepath: string): Promise<THREE.Group> {
  const file = Bun.file(filepath);
  if (!await file.exists()) {
    console.error(`Error: file not found: ${filepath}`);
    process.exit(1);
  }

  const bytes = await file.arrayBuffer();

  // Pre-extract embedded images from the GLB binary so we can decode them
  // with sharp (Bun has no DOM ImageLoader for blob: URLs that GLTFLoader creates).
  const imageBuffers = extractGLBImages(new Uint8Array(bytes));

  const loader = new GLTFLoader();

  // Enable Draco decoding — some GLBs use Draco mesh compression.
  try {
    const dracoLoader = new DRACOLoader();
    const dracoPath = join(
      import.meta.dir, '..', 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf',
    );
    dracoLoader.setDecoderPath('file://' + dracoPath + '/');
    dracoLoader.setDecoderConfig({ type: 'js' });
    loader.setDRACOLoader(dracoLoader);
  } catch {
    // Draco not available — only plain GLBs will work
  }

  const scene = await new Promise<THREE.Group>((resolve, reject) => {
    loader.parse(bytes, '', (gltf) => {
      resolve(gltf.scene);
    }, (error) => {
      reject(new Error(`GLTF parse error: ${error}`));
    });
  });

  // Post-load: decode embedded textures with sharp and replace broken blob-based
  // textures with DataTexture containing raw RGBA pixels.
  if (imageBuffers.length > 0) {
    await decodeTexturesWithSharp(scene, imageBuffers, new Uint8Array(bytes));
  }

  return scene;
}

/**
 * Extract embedded image buffers from a GLB file's binary chunk.
 * Parses the glTF JSON to find image buffer views, then slices the binary data.
 */
function extractGLBImages(glb: Uint8Array): Uint8Array[] {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);

  // GLB header: magic(4) + version(4) + length(4)
  if (view.getUint32(0, true) !== 0x46546C67) return []; // Not a GLB

  // Chunk 0: JSON
  const jsonLen = view.getUint32(12, true);
  const jsonBytes = glb.slice(20, 20 + jsonLen);
  const json = JSON.parse(new TextDecoder().decode(jsonBytes));

  // Chunk 1: BIN
  const binOffset = 20 + jsonLen;
  if (binOffset + 8 > glb.byteLength) return [];
  const binLen = view.getUint32(binOffset, true);
  const binData = glb.slice(binOffset + 8, binOffset + 8 + binLen);

  // Extract image data from buffer views
  const images: Uint8Array[] = [];
  const gltfImages = json.images as Array<{ bufferView?: number; mimeType?: string }> | undefined;
  const bufferViews = json.bufferViews as Array<{ byteOffset?: number; byteLength: number }> | undefined;

  if (!gltfImages || !bufferViews) return [];

  for (const img of gltfImages) {
    if (img.bufferView === undefined) {
      images.push(new Uint8Array(0)); // External reference, can't decode
      continue;
    }
    const bv = bufferViews[img.bufferView];
    const offset = bv.byteOffset ?? 0;
    images.push(binData.slice(offset, offset + bv.byteLength));
  }

  return images;
}

/**
 * Decode image buffers with sharp and replace broken textures on meshes.
 * Matches textures to meshes by order of appearance in the glTF image array.
 */
async function decodeTexturesWithSharp(
  scene: THREE.Group,
  imageBuffers: Uint8Array[],
  glb: Uint8Array,
): Promise<void> {
  let sharp: typeof import('sharp');
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.warn('[voxelize] sharp not available — textures will use material.color fallback');
    return;
  }

  // Decode all images to raw RGBA
  const decoded: Array<{ data: Uint8Array; width: number; height: number } | null> = [];
  for (let i = 0; i < imageBuffers.length; i++) {
    const buf = imageBuffers[i];
    if (buf.length === 0) { decoded.push(null); continue; }
    try {
      const img = sharp(Buffer.from(buf));
      const meta = await img.metadata();
      const raw = await img.ensureAlpha().raw().toBuffer();
      decoded.push({
        data: new Uint8Array(raw),
        width: meta.width ?? 0,
        height: meta.height ?? 0,
      });
    } catch {
      decoded.push(null);
    }
  }

  const validCount = decoded.filter(d => d !== null).length;
  if (validCount === 0) return;

  // Build a set of DataTextures from decoded images
  const dataTextures: THREE.DataTexture[] = decoded.map(d => {
    if (!d) return new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const tex = new THREE.DataTexture(d.data, d.width, d.height, THREE.RGBAFormat);
    tex.needsUpdate = true;
    tex.flipY = false; // glTF textures are not flipped
    return tex;
  });

  // GLTFLoader in headless Bun sets mat.map = null because blob: URL textures
  // can't be decoded without a DOM. We match materials to textures using the
  // glTF JSON: material → baseColorTexture.index → textures[].source → images[].
  const glbView2 = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen2 = glbView2.getUint32(12, true);
  const jsonBytes2 = glb.slice(20, 20 + jsonLen2);
  const gltfJson = JSON.parse(new TextDecoder().decode(jsonBytes2));

  const gltfMaterials = gltfJson.materials as Array<{
    pbrMetallicRoughness?: { baseColorTexture?: { index: number } };
  }> | undefined;
  const gltfTextures = gltfJson.textures as Array<{ source?: number }> | undefined;

  // Map material index → decoded image DataTexture
  const matToTexture = new Map<number, THREE.DataTexture>();
  if (gltfMaterials && gltfTextures) {
    for (let mi = 0; mi < gltfMaterials.length; mi++) {
      const texRef = gltfMaterials[mi].pbrMetallicRoughness?.baseColorTexture;
      if (texRef !== undefined) {
        const texEntry = gltfTextures[texRef.index];
        if (texEntry?.source !== undefined && decoded[texEntry.source]) {
          matToTexture.set(mi, dataTextures[texEntry.source]);
        }
      }
    }
  }

  // Assign DataTextures to mesh materials (GLTFLoader creates materials in JSON order)
  let replaced = 0;
  const materialsSeen = new Map<THREE.Material, number>();
  let matIdx = 0;

  scene.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mat = child.material as THREE.MeshStandardMaterial;
    if (!mat) return;

    let mi = materialsSeen.get(mat);
    if (mi === undefined) {
      mi = matIdx++;
      materialsSeen.set(mat, mi);
    }

    const tex = matToTexture.get(mi);
    if (tex) {
      mat.map = tex;
      mat.needsUpdate = true;
      replaced++;
    }
  });

  console.log(`[voxelize] Decoded ${validCount}/${imageBuffers.length} textures, assigned to ${replaced} meshes`);
}

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
 */
function reorientToENU(scene: THREE.Group): void {
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);

  const maxXZ = Math.max(size.x, size.z);
  if (maxXZ < 0.01) return; // Degenerate mesh

  const yRatio = size.y / maxXZ;
  if (yRatio < 0.8) {
    console.log(`ENU check: Y/XZ ratio ${yRatio.toFixed(2)} — already oriented (Y-up)`);
    return;
  }

  // The scene center approximates the ECEF "up" direction for the capture location.
  // We want to rotate this direction to align with (0, 1, 0).
  const center = new THREE.Vector3();
  box.getCenter(center);

  // Compute the "up" direction: for ECEF data centered near origin,
  // the center-of-mass direction points "up" (away from Earth center).
  // For reoriented data the center is near (0, 0, 0) but "up" is along the
  // axis with the smallest bounding extent relative to mesh surface normals.
  // Use PCA on mesh vertex positions to find the flattest axis.
  const upDir = estimateUpDirection(scene);
  console.log(`ENU reorientation: detected up direction (${upDir.x.toFixed(3)}, ${upDir.y.toFixed(3)}, ${upDir.z.toFixed(3)})`);

  // Rotation that maps upDir → (0, 1, 0)
  const targetUp = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion().setFromUnitVectors(upDir, targetUp);

  // Apply rotation to all meshes
  const rotMatrix = new THREE.Matrix4().makeRotationFromQuaternion(quat);
  scene.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      child.geometry.applyMatrix4(rotMatrix);
    }
  });

  // Recenter so ground is at Y=0
  const newBox = new THREE.Box3().setFromObject(scene);
  const shift = new THREE.Vector3(-newBox.min.x, -newBox.min.y, -newBox.min.z);
  // Center XZ, keep Y at ground=0
  const newSize = new THREE.Vector3();
  newBox.getSize(newSize);
  shift.x = -(newBox.min.x + newSize.x / 2);
  shift.z = -(newBox.min.z + newSize.z / 2);
  shift.y = -newBox.min.y;

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
}

/**
 * Estimate the "up" direction of an ECEF mesh cluster using PCA.
 * The smallest principal component of the vertex positions corresponds
 * to the axis along which the data is flattest — i.e., the vertical axis
 * for a mostly-horizontal neighborhood capture.
 */
function estimateUpDirection(scene: THREE.Group): THREE.Vector3 {
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

  if (positions.length < 10) return new THREE.Vector3(0, 1, 0);

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
  return eigenvectors.minEigenvector;
}

/**
 * Jacobi eigenvalue decomposition for a 3x3 symmetric matrix.
 * Returns eigenvectors sorted by eigenvalue (ascending).
 */
function jacobi3x3(
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
  let minIdx = 0;
  if (eigenvalues[1] < eigenvalues[minIdx]) minIdx = 1;
  if (eigenvalues[2] < eigenvalues[minIdx]) minIdx = 2;

  // Min eigenvector is column minIdx of V
  const ev = new THREE.Vector3(v[0 * 3 + minIdx], v[1 * 3 + minIdx], v[2 * 3 + minIdx]);
  ev.normalize();

  // Ensure "up" points toward positive Y (arbitrary sign choice)
  if (ev.y < 0) ev.negate();

  console.log(`PCA eigenvalues: [${eigenvalues.map(e => e.toFixed(1)).join(', ')}], min axis index: ${minIdx}`);
  return { minEigenvector: ev };
}

// ─── Mesh Analysis ──────────────────────────────────────────────────────────

/** Collect mesh stats for --info output */
function analyzeMeshes(object: THREE.Object3D): {
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

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const t0 = performance.now();

  console.log(`Loading: ${args.inputPath}`);
  const scene = await loadGLB(args.inputPath);

  const stats = analyzeMeshes(scene);
  const size = new THREE.Vector3();
  stats.boundingBox.getSize(size);

  console.log(`Meshes: ${stats.meshCount} | Vertices: ${stats.vertexCount.toLocaleString()} | Triangles: ${stats.triangleCount.toLocaleString()}`);
  console.log(`Textures: ${stats.hasTextures ? 'yes' : 'no'}`);
  console.log(`Bounding box: ${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} meters`);
  console.log(`Grid estimate: ${Math.ceil(size.x * args.resolution)} x ${Math.ceil(size.y * args.resolution)} x ${Math.ceil(size.z * args.resolution)} blocks @ ${args.resolution} block/m`);

  if (args.infoOnly) {
    console.log(`\nLoaded in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  // Reorient ECEF-tilted meshes to local ENU (Y-up) before voxelization.
  // Google 3D Tiles use ECEF coordinates — "up" is radially outward from
  // Earth's center, not along any fixed axis. The ReorientationPlugin handles
  // this in the browser, but the exported GLB may retain ECEF orientation.
  // We detect tilt by comparing Y extent to XZ extent and correct if needed.
  reorientToENU(scene);

  // Height filter: collect candidate meshes and filter by vertical extent
  console.log(`\nHeight filter: min ${args.minHeight}m above ground`);
  const candidates: Array<{ child: THREE.Mesh; worldBox: THREE.Box3 }> = [];
  scene.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      child.updateWorldMatrix(true, false);
      const worldBox = new THREE.Box3().setFromObject(child);
      candidates.push({ child, worldBox });
    }
  });

  const { kept, groundY, heightFiltered } = filterMeshesByHeight(candidates, args.minHeight);
  console.log(`Ground Y: ${groundY.toFixed(1)} | Kept: ${kept.length}/${candidates.length} meshes (${heightFiltered} filtered)`);

  if (kept.length === 0) {
    console.error('No meshes survived height filter — try lowering --min-height');
    process.exit(1);
  }

  // Build a new group from kept meshes (clone with baked world transform)
  const filteredGroup = new THREE.Group();
  for (const { child } of kept) {
    const cloned = child.clone();
    cloned.applyMatrix4(child.matrixWorld);
    cloned.position.set(0, 0, 0);
    cloned.rotation.set(0, 0, 0);
    cloned.scale.set(1, 1, 1);
    cloned.updateMatrix();
    filteredGroup.add(cloned);
  }

  // Voxelize
  console.log(`\nVoxelizing: ${args.mode} mode, ${args.resolution} block/m, gamma ${args.gamma}, kernel ${args.kernel}, desat ${args.desaturate}`);
  const sampler = createDataTextureSampler(args.gamma, args.kernel, args.desaturate);
  const tVox = performance.now();
  const grid = threeToGrid(filteredGroup, args.resolution, {
    textureSampler: sampler,
    mode: args.mode,
    onProgress: (p) => {
      if (p.message) {
        process.stdout.write(`\r  ${p.message}`);
      } else {
        process.stdout.write(`\r  Layer ${p.currentY}/${p.totalY} (${Math.round(p.progress * 100)}%)`);
      }
    },
  });
  process.stdout.write('\n');
  console.log(`Voxelized in ${((performance.now() - tVox) / 1000).toFixed(1)}s`);

  // Trim sparse bottom layers
  const trimmed = trimSparseBottomLayers(grid, args.trimThreshold);
  if (trimmed !== grid) {
    const removed = grid.height - trimmed.height;
    console.log(`Trimmed ${removed} sparse bottom layers (${grid.height} → ${trimmed.height})`);
  }

  // Interior fill — flood-fill per Y-layer identifies building interiors
  // (dilate walls to close porosity, flood from edges = exterior, fill rest).
  // dilateRadius=3 closes 1-3 voxel wall gaps from photogrammetry noise.
  const interiorFilled = fillInteriorGaps(trimmed, 3);
  console.log(`Interior fill (flood): ${interiorFilled} interior voxels filled`);

  // Solidify core — "Cookie Cutter" method: one global AABB per Y-layer.
  // Core zone (>4 blocks from all edges) → fill solid with dominant block.
  // Facade zone (≤4 blocks from any edge) → leave raw scan data untouched.
  // Unlike rectangularize (which splits connected components and can fracture
  // buildings through fire escapes), this treats the whole layer as one volume.
  // Balconies, recesses, and windows are preserved because facade zone air is
  // never filled — the scan truth is respected on all building faces.
  const coreFilled = solidifyCore(trimmed, 4);
  console.log(`Solidify core: ${coreFilled} interior voxels filled (facade depth=4)`);

  // Carve facade shadows → depth features.
  // Dark blocks in the facade zone represent shadows inside balconies, windows,
  // and recesses. Photogrammetry fills these gaps geometrically, but the texture
  // correctly captured the shadows. Converting dark → air restores 3D depth
  // from 2D color information. Must run BEFORE palette constraint so the
  // original dark colors haven't been remapped to stucco yet.
  // Threshold 0.45 catches mid-grey shadow blocks (stone, andesite, gray_concrete).
  // Neighbor check (≥2 dark of 4 XZ neighbors) acts as despeckle — only carves
  // connected dark clusters (windows, balconies), not isolated dark specks.
  const carvedCount = carveFacadeShadows(trimmed, 4, 0.45, 2);
  console.log(`Facade carving: ${carvedCount} dark blocks → air (lum<0.45, depth=4, neighbors≥2)`);

  // Smooth rare/noisy blocks — replace blocks <2% frequency with neighbors.
  const smoothed = smoothRareBlocks(trimmed, 0.02);
  if (smoothed > 0) {
    console.log(`Smoothed ${smoothed} rare blocks`);
  }

  // Palette constraint — aggressively remap to uniform stucco.
  // The real building is cream/white stucco. Grey stone and cobblestone
  // patches from photogrammetry shadows look like "scabs" on the facade.
  // Map everything except the cleanest light blocks to stucco materials.
  const paletteReplacements = new Map<string, string>([
    // Dark stone → warm stucco (baked shadow artifacts)
    ['minecraft:blackstone', 'minecraft:smooth_sandstone'],
    ['minecraft:deepslate_bricks', 'minecraft:smooth_sandstone'],
    ['minecraft:polished_deepslate', 'minecraft:smooth_sandstone'],
    ['minecraft:polished_blackstone', 'minecraft:smooth_sandstone'],
    ['minecraft:nether_bricks', 'minecraft:smooth_sandstone'],
    // Mid-grey stone → light concrete (all stone types are shadow artifacts)
    ['minecraft:stone', 'minecraft:smooth_sandstone'],
    ['minecraft:andesite', 'minecraft:smooth_sandstone'],
    ['minecraft:polished_andesite', 'minecraft:light_gray_concrete'],
    ['minecraft:stone_bricks', 'minecraft:light_gray_concrete'],
    ['minecraft:smooth_stone', 'minecraft:light_gray_concrete'],
    ['minecraft:cobblestone', 'minecraft:smooth_sandstone'],
    // Grey concrete → lighter (uniform wall color)
    ['minecraft:gray_concrete', 'minecraft:light_gray_concrete'],
    // Dark glass → gray stained glass (window material, not black)
    ['minecraft:black_stained_glass', 'minecraft:gray_stained_glass'],
    // Red/orange/brown noise → stucco
    ['minecraft:red_terracotta', 'minecraft:smooth_sandstone'],
    ['minecraft:orange_terracotta', 'minecraft:smooth_sandstone'],
    ['minecraft:brown_terracotta', 'minecraft:smooth_sandstone'],
    ['minecraft:bricks', 'minecraft:smooth_sandstone'],
    ['minecraft:red_concrete', 'minecraft:smooth_sandstone'],
    // Green noise → stucco (vegetation artifact)
    ['minecraft:green_concrete', 'minecraft:smooth_sandstone'],
    // Iron → light gray (less harsh structural)
    ['minecraft:iron_block', 'minecraft:light_gray_concrete'],
    // End stone → sandstone (color family match)
    ['minecraft:end_stone_bricks', 'minecraft:smooth_sandstone'],
    // Keep: smooth_sandstone, light_gray_concrete, white_concrete,
    //        smooth_quartz, quartz_block, birch_planks, gray_stained_glass
  ]);
  const constrained = constrainPalette(trimmed, paletteReplacements);
  console.log(`Palette constrain: ${constrained} shadow blocks remapped`);

  // 3D mode filter — smooth surface textures while preserving color contrast.
  // Run after palette constraint so corrected colors spread via majority vote.
  const modeSmoothed = modeFilter3D(trimmed, 3, 2);
  if (modeSmoothed > 0) {
    console.log(`Mode filter 5x5x5: ${modeSmoothed} blocks homogenized`);
  }

  // Write output
  const nonAir = trimmed.countNonAir();
  console.log(`\nGrid: ${trimmed.width}x${trimmed.height}x${trimmed.length} | Blocks: ${nonAir.toLocaleString()} | Palette: ${trimmed.palette.size}`);
  console.log(`Palette: ${[...trimmed.palette].join(', ')}`);

  writeSchematic(trimmed, args.outputPath);
  const fileSize = Bun.file(args.outputPath).size;
  console.log(`\nWrote: ${args.outputPath} (${fileSize.toLocaleString()} bytes)`);
  console.log(`Total: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
