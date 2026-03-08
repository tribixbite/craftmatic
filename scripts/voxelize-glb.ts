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
import { filterMeshesByHeight } from '../src/convert/mesh-filter.js';
import { trimSparseBottomLayers } from '../src/convert/mesh-filter.js';
import { writeSchematic } from '../src/schem/write.js';
import { basename, extname, join, dirname } from 'node:path';

// ─── CLI Argument Parsing ───────────────────────────────────────────────────

interface CLIArgs {
  inputPath: string;
  resolution: number;
  mode: VoxelizeMode;
  minHeight: number;
  trimThreshold: number;
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

  return { inputPath, resolution, mode, minHeight, trimThreshold, outputPath, infoOnly };
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
  console.log(`\nVoxelizing: ${args.mode} mode, ${args.resolution} block/m`);
  const sampler = createDataTextureSampler();
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
