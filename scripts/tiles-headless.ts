#!/usr/bin/env bun
/**
 * Headless Google 3D Tiles downloader + GLB exporter.
 * Downloads tiles around a geocoded address WITHOUT WebGL/browser,
 * then saves the extracted meshes as a GLB file for the voxelizer pipeline.
 *
 * Usage:
 *   bun scripts/tiles-headless.ts "240 Highland St, Newton, MA" -r 50 -o output/tiles/test.glb
 *   bun scripts/tiles-headless.ts --lat=42.3435 --lng=-71.2092 -r 50 -o output/tiles/test.glb
 */
// Polyfill browser globals that 3d-tiles-renderer expects in Node.js/Bun
if (typeof globalThis.window === 'undefined') {
  (globalThis as any).window = {
    location: { href: 'https://localhost/' },
  };
}
if (typeof globalThis.document === 'undefined') {
  (globalThis as any).document = {
    createElementNS: () => ({}),
    createElement: () => ({ style: {} }),
  };
}
if (typeof globalThis.DOMParser === 'undefined') {
  (globalThis as any).DOMParser = class {
    parseFromString() { return { documentElement: {} }; }
  };
}
// rAF/cAF polyfills — 3d-tiles-renderer uses these for scheduling
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  let rafId = 0;
  const rafCallbacks = new Map<number, ReturnType<typeof setTimeout>>();
  (globalThis as any).requestAnimationFrame = (cb: () => void) => {
    const id = ++rafId;
    rafCallbacks.set(id, setTimeout(() => { rafCallbacks.delete(id); cb(); }, 0));
    return id;
  };
  (globalThis as any).cancelAnimationFrame = (id: number) => {
    const handle = rafCallbacks.get(id);
    if (handle) { clearTimeout(handle); rafCallbacks.delete(id); }
  };
}
// ImageBitmap polyfill (Three.js texture loader checks for it, dispose() uses instanceof)
if (typeof globalThis.ImageBitmap === 'undefined') {
  (globalThis as any).ImageBitmap = class ImageBitmap {
    width = 1; height = 1;
    close() {}
  };
}
if (typeof globalThis.createImageBitmap === 'undefined') {
  // Decode images using sharp so textures have real pixel data for the GLB export
  (globalThis as any).createImageBitmap = async (source: Blob | ArrayBuffer) => {
    try {
      const sharpMod = (await import('sharp')).default;
      let buf: Buffer;
      if (source instanceof Blob) {
        buf = Buffer.from(await source.arrayBuffer());
      } else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
        buf = Buffer.from(source as ArrayBuffer);
      } else {
        return new (globalThis as any).ImageBitmap();
      }
      const img = sharpMod(buf);
      const meta = await img.metadata();
      const pixels = await img.raw().ensureAlpha().toBuffer();
      return {
        width: meta.width ?? 1,
        height: meta.height ?? 1,
        data: new Uint8Array(pixels), // RGBA pixel data
        close() {},
      };
    } catch {
      return new (globalThis as any).ImageBitmap();
    }
  };
}
// ProgressEvent polyfill — Three.js FileLoader's fetch streaming creates these
if (typeof globalThis.ProgressEvent === 'undefined') {
  (globalThis as any).ProgressEvent = class ProgressEvent extends Event {
    lengthComputable: boolean;
    loaded: number;
    total: number;
    constructor(type: string, init: Record<string, unknown> = {}) {
      super(type);
      this.lengthComputable = (init.lengthComputable as boolean) ?? false;
      this.loaded = (init.loaded as number) ?? 0;
      this.total = (init.total as number) ?? 0;
    }
  };
}

import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin, ReorientationPlugin, GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { FIVE_ANGLE_PRESET, positionCameraForAngle, computeCameraDistance, waitForStable } from '../src/convert/multi-angle-capture.js';
import { writeFile as fsWriteFile } from 'fs/promises';
import { resolve } from 'path';

// Parse CLI args — collect non-flag words as address parts
const args = process.argv.slice(2);
const addressParts: string[] = [];
let lat: number | null = null;
let lng: number | null = null;
let radius = 50;
let outputPath = '';
let timeout = 120000; // 2 min default
// Camera mode: 'ortho' (top-down, best for complex footprints),
// 'perspective' (45° angle, best for facade detail on skyscrapers),
// 'street' (ground level, original mode)
let cameraMode: 'ortho' | 'perspective' | 'street' = 'ortho';
let multiAngle = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--lat=')) lat = parseFloat(a.split('=')[1]);
  else if (a.startsWith('--lng=')) lng = parseFloat(a.split('=')[1]);
  else if (a === '-r' || a === '--radius') radius = parseInt(args[++i]);
  else if (a.startsWith('-r') && a.length > 2) radius = parseInt(a.slice(2));
  else if (a === '-o' || a === '--output') outputPath = args[++i];
  else if (a === '-t' || a === '--timeout') timeout = parseInt(args[++i]) * 1000;
  else if (a === '--multi-angle') multiAngle = true;
  else if (a === '--camera' && i + 1 < args.length) {
    const mode = args[++i];
    if (mode === 'ortho' || mode === 'perspective' || mode === 'street') cameraMode = mode;
    else { console.error(`Unknown camera mode: ${mode}. Use ortho, perspective, or street.`); process.exit(1); }
  }
  else if (!a.startsWith('-')) addressParts.push(a);
}
const address = addressParts.join(' ');

if (!address && (lat === null || lng === null)) {
  console.error('Usage: bun scripts/tiles-headless.ts "address" -r 50 -o output.glb');
  console.error('   or: bun scripts/tiles-headless.ts --lat=42.3 --lng=-71.2 -r 50 -o output.glb');
  process.exit(1);
}

// Load API key
const dotenv = await Bun.file(resolve(import.meta.dir, '../.env')).text();
const apiKey = dotenv.match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim();
if (!apiKey) {
  console.error('Error: GOOGLE_MAPS_API_KEY not found in .env');
  process.exit(1);
}

// Geocode if needed
if (!lat || !lng) {
  console.log(`Geocoding: ${address}`);
  const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  const geoResp = await fetch(geoUrl);
  const geoData = await geoResp.json() as { results: Array<{ geometry: { location: { lat: number; lng: number } }; formatted_address: string }> };
  if (!geoData.results?.length) {
    console.error('Geocoding failed:', JSON.stringify(geoData));
    process.exit(1);
  }
  lat = geoData.results[0].geometry.location.lat;
  lng = geoData.results[0].geometry.location.lng;
  console.log(`  → ${geoData.results[0].formatted_address} (${lat}, ${lng})`);
}

if (!outputPath) {
  const slug = address ? address.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40) : `${lat!.toFixed(4)}-${lng!.toFixed(4)}`;
  outputPath = resolve(import.meta.dir, `../output/tiles/tiles-${slug}.glb`);
}
// Resolve relative paths against project root (not CWD, which Bun may set to .bun/tmp/)
const projectRoot = resolve(import.meta.dir, '..');
outputPath = resolve(projectRoot, outputPath);

console.log(`\nTarget: lat=${lat}, lng=${lng}, radius=${radius}m`);
console.log(`Output: ${outputPath}`);
console.log(`Timeout: ${timeout / 1000}s`);
console.log(`Camera: ${cameraMode}`);

// Set up camera based on mode
// - ortho: OrthographicCamera from Y=500 looking down. Best for complex footprints
//   (Capitol, Pentagon, sprawling buildings). Captures full XZ extent but low facade detail.
// - perspective: PerspectiveCamera at 45° angle from moderate height. Best for skyscrapers
//   (ESB, Chrysler, Willis). Captures vertical detail and facade articulation.
// - street: PerspectiveCamera at ground level (0,8,8). Original mode. Highest facade detail
//   for nearby surfaces but frustum clips everything above ~50m.
let camera: THREE.Camera;
if (cameraMode === 'ortho') {
  const halfExtent = radius * 1.5;
  camera = new THREE.OrthographicCamera(
    -halfExtent, halfExtent, halfExtent, -halfExtent, 1, 2000,
  );
  camera.position.set(0, 500, 0);
  camera.lookAt(0, 0, 0);
} else if (cameraMode === 'perspective') {
  // 45° angle from moderate height — balances footprint coverage with facade visibility
  camera = new THREE.PerspectiveCamera(60, 1, 1, 4000);
  const dist = radius * 2;
  camera.position.set(dist * 0.7, dist, dist * 0.7);
  camera.lookAt(0, radius * 0.3, 0); // look slightly above center
} else {
  // Street-level view — best for nearby facade detail
  camera = new THREE.PerspectiveCamera(60, 1, 1, 4000);
  camera.position.set(0, 8, 8);
  camera.lookAt(0, 0, 0);
}
camera.updateMatrixWorld(true);

// Create TilesRenderer
const tiles = new TilesRenderer();

// Google Cloud auth
tiles.registerPlugin(new GoogleCloudAuthPlugin({
  apiToken: apiKey,
  useRecommendedSettings: false, // we set our own errorTarget
}));

// Reorientation: positions tiles so the target lat/lng is at scene origin
tiles.registerPlugin(new ReorientationPlugin({
  lat: lat! * THREE.MathUtils.DEG2RAD,
  lon: lng! * THREE.MathUtils.DEG2RAD,
  height: 0,
  recenter: true,
}));

// DRACO decoder — Bun Workers can't run emscripten-compiled draco_decoder.js,
// so we monkey-patch DRACOLoader to decode in the main thread via WASM.
const dracoDir = resolve(import.meta.dir, '..', 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf');
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('file://' + dracoDir + '/');
dracoLoader.setDecoderConfig({ type: 'js' }); // must set to avoid wasm path in _initDecoder

// Load the JS decoder in the main thread and create a synchronous decode function
// Emscripten's Node.js detection uses require('fs') + require('path') + __dirname — polyfill for Bun ESM
if (typeof globalThis.require === 'undefined') {
  const nodeFs = await import('fs');
  const nodePath = await import('path');
  (globalThis as any).require = (id: string) => {
    if (id === 'fs') return nodeFs;
    if (id === 'path') return nodePath;
    throw new Error(`require('${id}') not polyfilled`);
  };
}
// __dirname needed by emscripten for locating .wasm file (even though JS decoder doesn't use it)
if (typeof (globalThis as any).__dirname === 'undefined') {
  (globalThis as any).__dirname = dracoDir;
}
const decoderJS = await Bun.file(resolve(dracoDir, 'draco_decoder.js')).text();
// The decoder script defines DracoDecoderModule as a global factory function
const decoderFactory = new Function(decoderJS + '\nreturn DracoDecoderModule;')();
const dracoModule = await new Promise<any>((res) => {
  decoderFactory({ onModuleLoaded: (draco: any) => res(draco) });
});
console.log('DRACO decoder loaded in main thread');

// Helper functions replicated from DRACOWorker (three/examples/jsm/loaders/DRACOLoader.js)
function getDracoDataType(draco: any, attributeType: any) {
  switch (attributeType) {
    case Float32Array: return draco.DT_FLOAT32;
    case Int8Array: return draco.DT_INT8;
    case Int16Array: return draco.DT_INT16;
    case Int32Array: return draco.DT_INT32;
    case Uint8Array: return draco.DT_UINT8;
    case Uint16Array: return draco.DT_UINT16;
    case Uint32Array: return draco.DT_UINT32;
  }
}

function decodeDracoGeometry(draco: any, buffer: ArrayBuffer, taskConfig: any) {
  const decoder = new draco.Decoder();
  try {
    const array = new Int8Array(buffer);
    let dracoGeometry: any;
    let decodingStatus: any;
    const geometryType = decoder.GetEncodedGeometryType(array);
    if (geometryType === draco.TRIANGULAR_MESH) {
      dracoGeometry = new draco.Mesh();
      decodingStatus = decoder.DecodeArrayToMesh(array, array.byteLength, dracoGeometry);
    } else if (geometryType === draco.POINT_CLOUD) {
      dracoGeometry = new draco.PointCloud();
      decodingStatus = decoder.DecodeArrayToPointCloud(array, array.byteLength, dracoGeometry);
    } else {
      throw new Error('Unexpected DRACO geometry type');
    }
    if (!decodingStatus.ok() || dracoGeometry.ptr === 0) {
      throw new Error('DRACO decode failed: ' + decodingStatus.error_msg());
    }
    const geometry: any = { index: null, attributes: [] };
    for (const name in taskConfig.attributeIDs) {
      const attrType = globalThis[taskConfig.attributeTypes[name] as keyof typeof globalThis] as any;
      let attribute: any, attrID: number;
      if (taskConfig.useUniqueIDs) {
        attrID = taskConfig.attributeIDs[name];
        attribute = decoder.GetAttributeByUniqueId(dracoGeometry, attrID);
      } else {
        attrID = decoder.GetAttributeId(dracoGeometry, draco[taskConfig.attributeIDs[name]]);
        if (attrID === -1) continue;
        attribute = decoder.GetAttribute(dracoGeometry, attrID);
      }
      const numComp = attribute.num_components();
      const numPts = dracoGeometry.num_points();
      const numVals = numPts * numComp;
      const byteLen = numVals * attrType.BYTES_PER_ELEMENT;
      const dataType = getDracoDataType(draco, attrType);
      const ptr = draco._malloc(byteLen);
      decoder.GetAttributeDataArrayForAllPoints(dracoGeometry, attribute, dataType, byteLen, ptr);
      const arr = new attrType(draco.HEAPF32.buffer, ptr, numVals).slice();
      draco._free(ptr);
      const result: any = { name, array: arr, itemSize: numComp };
      if (name === 'color') result.vertexColorSpace = taskConfig.vertexColorSpace;
      geometry.attributes.push(result);
    }
    if (geometryType === draco.TRIANGULAR_MESH) {
      const numFaces = dracoGeometry.num_faces();
      const numIdx = numFaces * 3;
      const idxBytes = numIdx * 4;
      const ptr = draco._malloc(idxBytes);
      decoder.GetTrianglesUInt32Array(dracoGeometry, idxBytes, ptr);
      geometry.index = { array: new Uint32Array(draco.HEAPF32.buffer, ptr, numIdx).slice(), itemSize: 1 };
      draco._free(ptr);
    }
    draco.destroy(dracoGeometry);
    return geometry;
  } finally {
    draco.destroy(decoder);
  }
}

// Override decodeGeometry to decode in main thread instead of Worker
(dracoLoader as any).decodeGeometry = function(buffer: ArrayBuffer, taskConfig: any) {
  return Promise.resolve().then(() => {
    const geometry = decodeDracoGeometry(dracoModule, buffer, taskConfig);
    return (this as any)._createGeometry(geometry);
  });
};

tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }));

// Configure LOD — lower errorTarget = higher detail but more tiles
// Multi-angle capture uses lower errorTarget for higher-detail facade tiles
tiles.errorTarget = multiAngle ? 2.0 : 4.0;

// Register camera (no renderer needed — we fake resolution)
tiles.setCamera(camera);
tiles.setResolution(camera, 512, 512);

console.log('\nLoading tiles...');
const startTime = Date.now();
let stableFrames = 0;
const STABLE_THRESHOLD = 100; // need many stable frames for deep LOD traversal
const MIN_LOADED = 3;
let lastLog = 0;

// Tile loading loop — call update() repeatedly to traverse LOD hierarchy
await new Promise<void>((resolve) => {
  const check = () => {
    const elapsed = Date.now() - startTime;

    // Update camera matrices (required for frustum culling)
    camera.updateMatrixWorld(true);

    // Drive the tile loading
    tiles.update();

    if (elapsed > timeout) {
      const loaded = (tiles.stats as Record<string, number>).loaded ?? 0;
      console.log(`  Timeout reached (${loaded} tiles loaded)`);
      resolve();
      return;
    }

    const stats = tiles.stats as Record<string, number>;
    const downloading = stats.downloading ?? 0;
    const parsing = stats.parsing ?? 0;
    const loaded = stats.loaded ?? 0;
    const failed = stats.failed ?? 0;

    if (downloading === 0 && parsing === 0 && loaded >= MIN_LOADED) {
      stableFrames++;
      if (stableFrames >= STABLE_THRESHOLD) {
        console.log(`  Tiles loaded: ${loaded} (${failed} failed)`);
        resolve();
        return;
      }
    } else {
      stableFrames = 0;
    }

    // Log progress every 2s
    if (elapsed - lastLog > 2000) {
      lastLog = elapsed;
      console.log(`  [${Math.round(elapsed / 1000)}s] d:${downloading} p:${parsing} ok:${loaded} fail:${failed} stable:${stableFrames}`);
    }

    setTimeout(check, 50);
  };
  setTimeout(check, 100);
});

const loadTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\nTile loading complete in ${loadTime}s`);

// Multi-angle capture: orbit camera through cardinal directions to force
// high-LOD tile loading on all facades (not just the initial camera angle)
if (multiAngle) {
  console.log('\n--- Multi-angle LOD forcing ---');
  // Compute building bounds from current tiles to determine camera distance
  const tempBbox = new THREE.Box3();
  tiles.group.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      const geo = child.geometry as THREE.BufferGeometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const worldBox = geo.boundingBox!.clone().applyMatrix4(child.matrixWorld);
      tempBbox.union(worldBox);
    }
  });
  const buildingSize = new THREE.Vector3();
  tempBbox.getSize(buildingSize);
  const camDist = computeCameraDistance(buildingSize);
  const center = new THREE.Vector3(0, buildingSize.y * 0.3, 0);

  for (const angle of FIVE_ANGLE_PRESET) {
    if (angle.name === 'top-down') continue; // already loaded from initial ortho/perspective
    console.log(`  Angle: ${angle.name}...`);

    // Reposition camera for this angle
    positionCameraForAngle(camera, center, angle, camDist);
    tiles.setCamera(camera);
    tiles.setResolution(camera, 512, 512);

    // Wait for tiles at this angle to stabilize
    await waitForStable(
      tiles as unknown as { stats: Record<string, number>; update: () => void },
      30000,
      30,
      (msg) => console.log(`    ${msg}`),
    );
  }
  console.log('  Multi-angle capture complete');
}

// Extract meshes within capture radius (XZ cylindrical filter)
const centerXZ = new THREE.Vector2(0, 0); // scene origin = target coordinate
const group = new THREE.Group();
let tested = 0;
let captured = 0;
let rejected = 0;

tiles.group.traverse((child) => {
  if (!(child instanceof THREE.Mesh)) return;
  if (!child.geometry) return;
  tested++;

  const geo = child.geometry as THREE.BufferGeometry;
  if (!geo.boundingSphere) geo.computeBoundingSphere();
  const worldSphere = geo.boundingSphere!.clone();
  worldSphere.applyMatrix4(child.matrixWorld);

  // XZ-only distance check (cylindrical filter preserves tall buildings)
  const meshXZ = new THREE.Vector2(worldSphere.center.x, worldSphere.center.z);
  const xzDist = centerXZ.distanceTo(meshXZ) - worldSphere.radius;
  if (xzDist > radius) {
    rejected++;
    return;
  }

  // Clone with world transform baked in
  const cloned = child.clone();
  cloned.applyMatrix4(child.matrixWorld);
  cloned.position.set(0, 0, 0);
  cloned.rotation.set(0, 0, 0);
  cloned.scale.set(1, 1, 1);
  cloned.updateMatrix();
  group.add(cloned);
  captured++;
});

console.log(`\nMeshes: tested=${tested} captured=${captured} rejected=${rejected}`);

if (captured === 0) {
  console.error('No meshes captured. Possible issues:');
  console.error('  - API key may not have 3D Tiles enabled');
  console.error('  - Location may not have 3D coverage');
  console.error('  - Radius too small or errorTarget too high');
  process.exit(1);
}

// Compute bounding box
const bbox = new THREE.Box3().setFromObject(group);
const size = new THREE.Vector3();
bbox.getSize(size);
console.log(`Bounding box: ${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} meters`);

// Extract terrain heightmap — rasterize ground-level mesh Y values into Float32Array
// for terrain-aware enrichment. Saved as .heightmap.bin sidecar alongside the GLB.
{
  const hmRes = 1; // 1 sample per meter
  const hmWidth = Math.ceil(size.x * hmRes);
  const hmLength = Math.ceil(size.z * hmRes);
  if (hmWidth > 0 && hmLength > 0 && hmWidth <= 1024 && hmLength <= 1024) {
    const heightmap = new Float32Array(hmWidth * hmLength);
    const counts = new Uint8Array(hmWidth * hmLength);

    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.geometry) return;
      const geo = child.geometry as THREE.BufferGeometry;
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      if (!pos) return;

      for (let i = 0; i < pos.count; i++) {
        const wx = pos.getX(i);
        const wy = pos.getY(i);
        const wz = pos.getZ(i);
        // Map world coords to heightmap pixel
        const px = Math.floor((wx - bbox.min.x) * hmRes);
        const pz = Math.floor((wz - bbox.min.z) * hmRes);
        if (px < 0 || px >= hmWidth || pz < 0 || pz >= hmLength) continue;
        const idx = pz * hmWidth + px;
        // Keep minimum Y at each XZ cell (ground level)
        if (counts[idx] === 0 || wy < heightmap[idx]) {
          heightmap[idx] = wy;
          counts[idx] = 1;
        }
      }
    });

    // Normalize relative to minimum height
    let minH = Infinity;
    for (let i = 0; i < heightmap.length; i++) {
      if (counts[i] > 0 && heightmap[i] < minH) minH = heightmap[i];
    }
    if (isFinite(minH)) {
      for (let i = 0; i < heightmap.length; i++) {
        heightmap[i] = counts[i] > 0 ? heightmap[i] - minH : 0;
      }
    }

    const hmPath = outputPath.replace(/\.glb$/, '.heightmap.bin');
    // Write as: [uint16 width] [uint16 length] [float32[] data]
    const header = new Uint16Array([hmWidth, hmLength]);
    const hmBuf = Buffer.concat([
      Buffer.from(header.buffer),
      Buffer.from(heightmap.buffer),
    ]);
    await fsWriteFile(hmPath, hmBuf);
    console.log(`Heightmap: ${hmWidth}x${hmLength} → ${hmPath} (${hmBuf.length.toLocaleString()} bytes)`);
  }
}

// Export as GLB — Three.js GLTFExporter needs Canvas 2D + FileReader (unavailable in headless Bun).
// Write GLB manually: collect geometry buffers + encode textures with sharp.
console.log('\nExporting GLB...');
const sharp = (await import('sharp')).default;

// Collect mesh data: positions, normals, UVs, indices, and texture images
interface MeshData {
  position: Float32Array;
  normal: Float32Array | null;
  uv: Float32Array | null;
  index: Uint32Array | null;
  textureJpeg: Buffer | null; // JPEG-encoded texture for embedding
  texWidth: number;
  texHeight: number;
}
const meshes: MeshData[] = [];
let texEncoded = 0;

for (const child of group.children) {
  if (!(child instanceof THREE.Mesh)) continue;
  const geo = child.geometry as THREE.BufferGeometry;
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  if (!posAttr) continue;

  const position = new Float32Array(posAttr.array);
  const normalAttr = geo.getAttribute('normal') as THREE.BufferAttribute | null;
  const normal = normalAttr ? new Float32Array(normalAttr.array) : null;
  const uvAttr = geo.getAttribute('uv') as THREE.BufferAttribute | null;
  const uv = uvAttr ? new Float32Array(uvAttr.array) : null;
  const indexAttr = geo.getIndex();
  const index = indexAttr ? new Uint32Array(indexAttr.array) : null;

  // Try to encode texture from material's map image data
  let textureJpeg: Buffer | null = null;
  let texWidth = 0, texHeight = 0;
  const mat = child.material as THREE.MeshStandardMaterial;
  const tex = mat?.map;
  if (tex?.image?.data && tex.image.width > 1 && tex.image.height > 1) {
    try {
      const w = tex.image.width;
      const h = tex.image.height;
      const imgData = new Uint8Array(tex.image.data.buffer ?? tex.image.data);
      // Determine channels from data length
      const channels = imgData.length / (w * h);
      textureJpeg = await sharp(Buffer.from(imgData), {
        raw: { width: w, height: h, channels: channels as 3 | 4 },
      }).jpeg({ quality: 85 }).toBuffer();
      texWidth = w;
      texHeight = h;
      texEncoded++;
    } catch { /* skip texture if encoding fails */ }
  }

  meshes.push({ position, normal, uv, index, textureJpeg, texWidth, texHeight });
}

console.log(`  Meshes: ${meshes.length}, textures encoded: ${texEncoded}`);

// Build GLB (glTF 2.0 binary) manually
// Spec: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#glb-file-format-specification
function buildGLB(meshData: MeshData[]): ArrayBuffer {
  const bufferViews: any[] = [];
  const accessors: any[] = [];
  const gltfMeshes: any[] = [];
  const nodes: any[] = [];
  const materials: any[] = [];
  const textures: any[] = [];
  const images: any[] = [];
  const samplers: any[] = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }]; // LINEAR, LINEAR_MIPMAP_LINEAR, CLAMP
  const binaryChunks: ArrayBuffer[] = [];
  let byteOffset = 0;

  function addBufferView(data: ArrayBuffer, target?: number): number {
    const idx = bufferViews.length;
    const view: any = { buffer: 0, byteOffset, byteLength: data.byteLength };
    if (target) view.target = target;
    bufferViews.push(view);
    binaryChunks.push(data);
    byteOffset += data.byteLength;
    // Pad to 4-byte alignment
    const pad = (4 - (data.byteLength % 4)) % 4;
    if (pad > 0) {
      binaryChunks.push(new ArrayBuffer(pad));
      byteOffset += pad;
    }
    return idx;
  }

  function addAccessor(bufferView: number, componentType: number, count: number, type: string, min?: number[], max?: number[]): number {
    const idx = accessors.length;
    const acc: any = { bufferView, componentType, count, type };
    if (min) acc.min = min;
    if (max) acc.max = max;
    accessors.push(acc);
    return idx;
  }

  for (let i = 0; i < meshData.length; i++) {
    const m = meshData[i];
    const primitive: any = { attributes: {}, mode: 4 }; // TRIANGLES

    // Position (required)
    const posView = addBufferView(m.position.buffer, 34962); // ARRAY_BUFFER
    const posMin = [Infinity, Infinity, Infinity];
    const posMax = [-Infinity, -Infinity, -Infinity];
    for (let j = 0; j < m.position.length; j += 3) {
      posMin[0] = Math.min(posMin[0], m.position[j]);
      posMin[1] = Math.min(posMin[1], m.position[j + 1]);
      posMin[2] = Math.min(posMin[2], m.position[j + 2]);
      posMax[0] = Math.max(posMax[0], m.position[j]);
      posMax[1] = Math.max(posMax[1], m.position[j + 1]);
      posMax[2] = Math.max(posMax[2], m.position[j + 2]);
    }
    primitive.attributes.POSITION = addAccessor(posView, 5126, m.position.length / 3, 'VEC3', posMin, posMax);

    // Normal
    if (m.normal) {
      const nView = addBufferView(m.normal.buffer, 34962);
      primitive.attributes.NORMAL = addAccessor(nView, 5126, m.normal.length / 3, 'VEC3');
    }

    // UV
    if (m.uv) {
      const uvView = addBufferView(m.uv.buffer, 34962);
      primitive.attributes.TEXCOORD_0 = addAccessor(uvView, 5126, m.uv.length / 2, 'VEC2');
    }

    // Index
    if (m.index) {
      const idxView = addBufferView(m.index.buffer, 34963); // ELEMENT_ARRAY_BUFFER
      primitive.indices = addAccessor(idxView, 5125, m.index.length, 'SCALAR');
    }

    // Material with texture
    const matIdx = materials.length;
    if (m.textureJpeg && m.uv) {
      const imgView = addBufferView(m.textureJpeg.buffer); // no target for images
      const imgIdx = images.length;
      images.push({ bufferView: imgView, mimeType: 'image/jpeg' });
      const texIdx = textures.length;
      textures.push({ sampler: 0, source: imgIdx });
      materials.push({
        pbrMetallicRoughness: {
          baseColorTexture: { index: texIdx },
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      });
    } else {
      materials.push({
        pbrMetallicRoughness: {
          baseColorFactor: [0.5, 0.5, 0.5, 1.0],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      });
    }
    primitive.material = matIdx;

    gltfMeshes.push({ primitives: [primitive] });
    nodes.push({ mesh: i });
  }

  // Build JSON
  const gltf: any = {
    asset: { version: '2.0', generator: 'craftmatic-tiles-headless' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: gltfMeshes,
    accessors,
    bufferViews,
    materials,
    buffers: [{ byteLength: byteOffset }],
  };
  if (textures.length > 0) {
    gltf.textures = textures;
    gltf.images = images;
    gltf.samplers = samplers;
  }

  const jsonStr = JSON.stringify(gltf);
  const jsonBytes = new TextEncoder().encode(jsonStr);
  // Pad JSON to 4-byte alignment with spaces
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunk = new Uint8Array(jsonBytes.length + jsonPad);
  jsonChunk.set(jsonBytes);
  jsonChunk.fill(0x20, jsonBytes.length); // space padding

  // Binary chunk = concatenated binaryChunks
  const binSize = byteOffset;
  const binChunk = new Uint8Array(binSize);
  let off = 0;
  for (const chunk of binaryChunks) {
    binChunk.set(new Uint8Array(chunk), off);
    off += chunk.byteLength;
  }

  // GLB header (12 bytes) + JSON chunk header (8) + JSON + BIN chunk header (8) + BIN
  const totalLen = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const glb = new ArrayBuffer(totalLen);
  const view = new DataView(glb);
  // Header
  view.setUint32(0, 0x46546C67, true); // magic "glTF"
  view.setUint32(4, 2, true);          // version
  view.setUint32(8, totalLen, true);    // total length
  // JSON chunk
  view.setUint32(12, jsonChunk.length, true);
  view.setUint32(16, 0x4E4F534A, true); // "JSON"
  new Uint8Array(glb, 20).set(jsonChunk);
  // BIN chunk
  const binOff = 20 + jsonChunk.length;
  view.setUint32(binOff, binChunk.length, true);
  view.setUint32(binOff + 4, 0x004E4942, true); // "BIN\0"
  new Uint8Array(glb, binOff + 8).set(binChunk);

  return glb;
}

const glbData = buildGLB(meshes);
await fsWriteFile(outputPath, Buffer.from(glbData));
const sizeKB = (glbData.byteLength / 1024).toFixed(0);
console.log(`  → ${outputPath} (${sizeKB}KB)`);
console.log(`\nDone! Feed this GLB to the voxelizer:`);
console.log(`  bun scripts/voxelize-glb.ts ${outputPath} -r 4 -m surface --generic --fill --mode-passes 3 --smooth-pct 0.03 -o output/tiles/result-v26.schem`);

// Cleanup
try { tiles.dispose(); } catch { /* cleanup errors are non-fatal in headless mode */ }
