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

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
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

/** Load a GLB file from disk into a Three.js scene */
async function loadGLB(filepath: string): Promise<THREE.Group> {
  const file = Bun.file(filepath);
  if (!await file.exists()) {
    console.error(`Error: file not found: ${filepath}`);
    process.exit(1);
  }

  const bytes = await file.arrayBuffer();
  const loader = new GLTFLoader();

  return new Promise<THREE.Group>((resolve, reject) => {
    loader.parse(bytes, '', (gltf) => {
      resolve(gltf.scene);
    }, (error) => {
      reject(new Error(`GLTF parse error: ${error}`));
    });
  });
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
