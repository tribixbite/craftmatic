/**
 * Export utilities: GLB, STL, OBJ, .schem, .litematic, Three.js JSON, and standalone HTML.
 */

import * as THREE from 'three';
import pako from 'pako';
import type { ViewerState } from './scene.js';
import { BlockGrid } from '@craft/schem/types.js';
import { encodeBitPackedStates, decomposeBlockState, calcBitsPerEntry } from '@craft/schem/litematic-encode.js';

/** Trigger a browser download of a Blob */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}

/**
 * Expand InstancedMesh objects from the viewer into a flat group of regular
 * Mesh objects suitable for export. Most Three.js exporters (STL, GLTF, OBJ)
 * don't properly handle InstancedMesh, so we expand each instance into its
 * own Mesh with the correct world transform applied.
 *
 * IMPORTANT: Calls updateMatrixWorld() so exporters that read matrixWorld
 * (STL, GLTF) see correct positions instead of identity matrices.
 */
function createExportGroup(viewer: ViewerState): { group: THREE.Group; cleanup: () => void } {
  const group = new THREE.Group();
  const tempMeshes: THREE.Mesh[] = [];

  for (const instMesh of viewer.meshes) {
    const originals = instMesh.userData.originalMatrices as THREE.Matrix4[] | undefined;
    if (!originals) continue;
    const mat = instMesh.material as THREE.MeshStandardMaterial;
    for (const matrix of originals) {
      const mesh = new THREE.Mesh(instMesh.geometry, mat);
      mesh.applyMatrix4(matrix);
      group.add(mesh);
      tempMeshes.push(mesh);
    }
  }

  // Compute matrixWorld for all children — exporters rely on this
  group.updateMatrixWorld(true);

  return {
    group,
    cleanup: () => {
      for (const m of tempMeshes) {
        m.geometry = undefined!; // Don't dispose shared geometry
        group.remove(m);
      }
    },
  };
}

/** Export the current Three.js scene as GLB (binary glTF) */
export async function exportGLB(viewer: ViewerState, filename = 'craftmatic.glb'): Promise<void> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const exporter = new GLTFExporter();

  // Expand InstancedMesh — GLTFExporter's InstancedMesh support is unreliable
  const { group, cleanup } = createExportGroup(viewer);

  return new Promise((resolve, reject) => {
    exporter.parse(
      group,
      (result) => {
        cleanup();
        const blob = new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
        downloadBlob(blob, filename);
        resolve();
      },
      (error) => { cleanup(); reject(error); },
      { binary: true }
    );
  });
}

/** Export the current Three.js scene as binary STL (3D printing) */
export async function exportSTL(viewer: ViewerState, filename = 'craftmatic.stl'): Promise<void> {
  const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js');
  const exporter = new STLExporter();
  const { group, cleanup } = createExportGroup(viewer);

  const result = exporter.parse(group, { binary: true });
  cleanup();

  const blob = new Blob([result], { type: 'application/octet-stream' });
  downloadBlob(blob, filename);
}

/** Export the current Three.js scene as OBJ (universal 3D format) */
export async function exportOBJ(viewer: ViewerState, filename = 'craftmatic.obj'): Promise<void> {
  const { OBJExporter } = await import('three/examples/jsm/exporters/OBJExporter.js');
  const exporter = new OBJExporter();
  const { group, cleanup } = createExportGroup(viewer);

  const result = exporter.parse(group);
  cleanup();

  const blob = new Blob([result], { type: 'text/plain' });
  downloadBlob(blob, filename);
}

/** Export the BlockGrid as a .schem file */
export function exportSchem(grid: BlockGrid, filename = 'craftmatic.schem'): void {
  const { width, height, length } = grid;

  // Build palette
  const palette = grid.palette;
  const paletteEntries: Array<[string, number]> = [];
  for (const [blockState, id] of palette) {
    paletteEntries.push([blockState, id]);
  }

  // Encode block data as varints
  const blockData = grid.encodeBlockData();

  // Build NBT structure manually (simplified — writes raw binary)
  const parts: number[] = [];
  const encoder = new TextEncoder();

  function writeByte(v: number) { parts.push(v & 0xff); }
  function writeShort(v: number) { parts.push((v >> 8) & 0xff, v & 0xff); }
  function writeInt(v: number) {
    parts.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  }
  function writeString(s: string) {
    const bytes = encoder.encode(s);
    writeShort(bytes.length);
    for (const b of bytes) parts.push(b);
  }
  function writeByteArray(arr: Uint8Array) {
    writeInt(arr.length);
    for (const b of arr) parts.push(b);
  }

  // Root compound
  writeByte(10); // TAG_Compound
  writeString('Schematic');

  // Version
  writeByte(3); // TAG_Int
  writeString('Version');
  writeInt(2);

  // DataVersion
  writeByte(3); // TAG_Int
  writeString('DataVersion');
  writeInt(3700);

  // Width
  writeByte(2); // TAG_Short
  writeString('Width');
  writeShort(width);

  // Height
  writeByte(2); // TAG_Short
  writeString('Height');
  writeShort(height);

  // Length
  writeByte(2); // TAG_Short
  writeString('Length');
  writeShort(length);

  // Palette compound
  writeByte(10); // TAG_Compound
  writeString('Palette');
  for (const [blockState, id] of paletteEntries) {
    writeByte(3); // TAG_Int
    writeString(blockState);
    writeInt(id);
  }
  writeByte(0); // TAG_End (Palette)

  // PaletteMax
  writeByte(3); // TAG_Int
  writeString('PaletteMax');
  writeInt(paletteEntries.length);

  // BlockData
  writeByte(7); // TAG_ByteArray
  writeString('BlockData');
  writeByteArray(blockData);

  // Offset
  writeByte(11); // TAG_IntArray
  writeString('Offset');
  writeInt(3);
  writeInt(0); writeInt(0); writeInt(0);

  // BlockEntities (empty list)
  writeByte(9); // TAG_List
  writeString('BlockEntities');
  writeByte(10); // list type: Compound
  writeInt(0); // length: 0

  writeByte(0); // TAG_End (root)

  // Gzip compress
  const raw = new Uint8Array(parts);
  const compressed = pako.gzip(raw);
  const blob = new Blob([compressed], { type: 'application/octet-stream' });
  downloadBlob(blob, filename);
}

/** Encode a BlockGrid as gzipped .schem bytes (no file download) */
export function encodeSchemBytes(grid: BlockGrid): Uint8Array {
  // Reuse exportSchem logic but return bytes instead of triggering download
  const { width, height, length } = grid;
  const palette = grid.palette;
  const paletteEntries: Array<[string, number]> = [];
  for (const [blockState, id] of palette) paletteEntries.push([blockState, id]);
  const blockData = grid.encodeBlockData();
  const parts: number[] = [];
  const enc = new TextEncoder();
  const wb = (v: number) => { parts.push(v & 0xff); };
  const ws = (v: number) => { parts.push((v >> 8) & 0xff, v & 0xff); };
  const wi = (v: number) => { parts.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff); };
  const wstr = (s: string) => { const b = enc.encode(s); ws(b.length); for (const x of b) parts.push(x); };
  const wba = (a: Uint8Array) => { wi(a.length); for (const x of a) parts.push(x); };

  wb(10); wstr('Schematic');
  wb(3); wstr('Version'); wi(2);
  wb(3); wstr('DataVersion'); wi(3700);
  wb(2); wstr('Width'); ws(width);
  wb(2); wstr('Height'); ws(height);
  wb(2); wstr('Length'); ws(length);
  wb(10); wstr('Palette');
  for (const [bs, id] of paletteEntries) { wb(3); wstr(bs); wi(id); }
  wb(0); // end palette
  wb(3); wstr('PaletteMax'); wi(paletteEntries.length);
  wb(7); wstr('BlockData'); wba(blockData);
  wb(10); wstr('Metadata');
  wb(3); wstr('WEOffsetX'); wi(0);
  wb(3); wstr('WEOffsetY'); wi(0);
  wb(3); wstr('WEOffsetZ'); wi(0);
  wb(0); // end metadata
  wb(11); wstr('Offset'); wi(3); wi(0); wi(0); wi(0);
  wb(9); wstr('BlockEntities'); wb(10); wi(0);
  wb(0); // end root

  return pako.gzip(new Uint8Array(parts));
}

/** Export the BlockGrid as a .litematic file (Litematica mod format) */
export function exportLitematic(grid: BlockGrid, filename = 'craftmatic.litematic'): void {
  const { width, height, length } = grid;
  const nonAirCount = grid.countNonAir();
  const totalVolume = width * height * length;
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const regionName = 'craftmatic';

  // Build inline NBT (same pattern as exportSchem — raw binary, no server deps)
  const parts: number[] = [];
  const encoder = new TextEncoder();

  function writeByte(v: number) { parts.push(v & 0xff); }
  function writeShort(v: number) { parts.push((v >> 8) & 0xff, v & 0xff); }
  function writeInt(v: number) {
    parts.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  }
  function writeLong(v: bigint) {
    const hi = Number((v >> 32n) & 0xffffffffn);
    const lo = Number(v & 0xffffffffn);
    writeInt(hi);
    writeInt(lo);
  }
  function writeString(s: string) {
    const bytes = encoder.encode(s);
    writeShort(bytes.length);
    for (const b of bytes) parts.push(b);
  }
  function writeTagHeader(tagType: number, name: string) {
    writeByte(tagType);
    writeString(name);
  }
  function writeEnd() { writeByte(0); }

  // NBT tag type constants
  const TAG_BYTE = 1, TAG_INT = 3, TAG_LONG = 4, TAG_STRING = 8;
  const TAG_LIST = 9, TAG_COMPOUND = 10, TAG_LONG_ARRAY = 12;

  // Root compound
  writeTagHeader(TAG_COMPOUND, '');

  // MinecraftDataVersion + Version
  writeTagHeader(TAG_INT, 'MinecraftDataVersion'); writeInt(3700);
  writeTagHeader(TAG_INT, 'Version'); writeInt(5);

  // Metadata
  writeTagHeader(TAG_COMPOUND, 'Metadata');
  writeTagHeader(TAG_STRING, 'Name'); writeString(regionName);
  writeTagHeader(TAG_STRING, 'Author'); writeString('craftmatic');
  writeTagHeader(TAG_STRING, 'Description'); writeString('');
  writeTagHeader(TAG_INT, 'RegionCount'); writeInt(1);
  writeTagHeader(TAG_LONG, 'TimeCreated'); writeLong(timestamp);
  writeTagHeader(TAG_LONG, 'TimeModified'); writeLong(timestamp);
  writeTagHeader(TAG_INT, 'TotalBlocks'); writeInt(nonAirCount);
  writeTagHeader(TAG_INT, 'TotalVolume'); writeInt(totalVolume);
  writeTagHeader(TAG_COMPOUND, 'EnclosingSize');
  writeTagHeader(TAG_INT, 'x'); writeInt(width);
  writeTagHeader(TAG_INT, 'y'); writeInt(height);
  writeTagHeader(TAG_INT, 'z'); writeInt(length);
  writeEnd(); // EnclosingSize
  writeEnd(); // Metadata

  // Regions
  writeTagHeader(TAG_COMPOUND, 'Regions');
  writeTagHeader(TAG_COMPOUND, regionName);

  // Position + Size
  writeTagHeader(TAG_COMPOUND, 'Position');
  writeTagHeader(TAG_INT, 'x'); writeInt(0);
  writeTagHeader(TAG_INT, 'y'); writeInt(0);
  writeTagHeader(TAG_INT, 'z'); writeInt(0);
  writeEnd();
  writeTagHeader(TAG_COMPOUND, 'Size');
  writeTagHeader(TAG_INT, 'x'); writeInt(width);
  writeTagHeader(TAG_INT, 'y'); writeInt(height);
  writeTagHeader(TAG_INT, 'z'); writeInt(length);
  writeEnd();

  // Build palette (air at index 0) and collect indices in Litematica XZY order
  const paletteMap = new Map<string, number>();
  const paletteList: string[] = [];
  paletteMap.set('minecraft:air', 0);
  paletteList.push('minecraft:air');

  const indices: number[] = new Array(totalVolume);
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const bs = grid.get(x, y, z);
        let idx = paletteMap.get(bs);
        if (idx === undefined) {
          idx = paletteList.length;
          paletteMap.set(bs, idx);
          paletteList.push(bs);
        }
        indices[x + z * width + y * width * length] = idx;
      }
    }
  }

  // BlockStatePalette
  writeTagHeader(TAG_LIST, 'BlockStatePalette');
  writeByte(TAG_COMPOUND);
  writeInt(paletteList.length);
  for (const blockState of paletteList) {
    const { name, properties } = decomposeBlockState(blockState);
    writeTagHeader(TAG_STRING, 'Name'); writeString(name);
    if (properties) {
      writeTagHeader(TAG_COMPOUND, 'Properties');
      for (const [key, val] of Object.entries(properties)) {
        writeTagHeader(TAG_STRING, key); writeString(val);
      }
      writeEnd();
    }
    writeEnd(); // palette entry
  }

  // BlockStates (bit-packed LongArray)
  const bitsPerEntry = calcBitsPerEntry(paletteList.length);
  const packed = encodeBitPackedStates(indices, bitsPerEntry);
  writeTagHeader(TAG_LONG_ARRAY, 'BlockStates');
  writeInt(packed.length);
  for (const v of packed) writeLong(v);

  // Empty lists (TileEntities, Entities, PendingBlockTicks, PendingFluidTicks)
  for (const listName of ['TileEntities', 'Entities', 'PendingBlockTicks', 'PendingFluidTicks']) {
    writeTagHeader(TAG_LIST, listName);
    writeByte(TAG_COMPOUND);
    writeInt(0);
  }

  writeEnd(); // region
  writeEnd(); // Regions
  writeEnd(); // root

  // Gzip compress
  const raw = new Uint8Array(parts);
  const compressed = pako.gzip(raw);
  const blob = new Blob([compressed], { type: 'application/octet-stream' });
  downloadBlob(blob, filename);
}

/** Export the Three.js scene as JSON (loadable via THREE.ObjectLoader) */
export function exportThreeJSON(viewer: ViewerState, filename = 'craftmatic-scene.json'): void {
  const json = viewer.scene.toJSON();
  const str = JSON.stringify(json);
  const blob = new Blob([str], { type: 'application/json' });
  downloadBlob(blob, filename);
}

/** Export as standalone HTML with embedded viewer */
export function exportHTML(viewer: ViewerState, filename = 'craftmatic.html'): void {
  const { grid } = viewer;
  const { width, height, length } = grid;

  // Build compact block list from the viewer's existing meshes
  const meshes = viewer.meshes;
  const data = { width, height, length, blockCount: 0, blocks: [] as Array<{ x: number; y: number; z: number; color: number[] }> };

  for (const mesh of meshes) {
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const color = mat.color;
    const rgb = [Math.round(color.r * 255), Math.round(color.g * 255), Math.round(color.b * 255)];
    const originals = mesh.userData.originalMatrices as THREE.Matrix4[];
    if (!originals) continue;
    for (const matrix of originals) {
      const pos = new THREE.Vector3();
      pos.setFromMatrixPosition(matrix);
      data.blocks.push({ x: pos.x, y: pos.y, z: pos.z, color: rgb });
    }
  }
  data.blockCount = data.blocks.length;

  const dataJson = JSON.stringify(data);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Craftmatic 3D Viewer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a14; overflow: hidden; font-family: system-ui, sans-serif; }
    canvas { display: block; }
    #info { position: fixed; top: 12px; left: 12px; color: #ddd; font-size: 13px;
            background: rgba(0,0,0,0.75); padding: 8px 14px; border-radius: 6px;
            pointer-events: none; backdrop-filter: blur(4px); }
    #controls { position: fixed; bottom: 12px; left: 12px; color: #999; font-size: 12px;
                background: rgba(0,0,0,0.75); padding: 6px 12px; border-radius: 6px;
                pointer-events: none; backdrop-filter: blur(4px); }
  </style>
</head>
<body>
  <div id="info">Craftmatic — ${width}x${height}x${length}</div>
  <div id="controls">Drag: rotate | Scroll: zoom | Right-drag: pan</div>
  <script type="importmap">
  { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.172.0/build/three.module.js",
                  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.172.0/examples/jsm/" } }
  </script>
  <script type="module">
    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
    const data = ${dataJson};
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);
    scene.fog = new THREE.FogExp2(0x1a1a2e, 0.006);
    const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(innerWidth, innerHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    document.body.appendChild(renderer.domElement);
    scene.add(new THREE.AmbientLight(0x606080, 0.5));
    scene.add(new THREE.HemisphereLight(0x87ceeb, 0x443322, 0.6));
    const sun = new THREE.DirectionalLight(0xfff0dd, 1.8);
    sun.position.set(40, 60, 25);
    scene.add(sun);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const groups = new Map();
    for (const b of data.blocks) {
      const key = b.color.join(',');
      if (!groups.has(key)) groups.set(key, { color: b.color, positions: [] });
      groups.get(key).positions.push(b);
    }
    for (const [, group] of groups) {
      const [r, g, b] = group.color;
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(r/255, g/255, b/255), roughness: 0.85 });
      const mesh = new THREE.InstancedMesh(geo, mat, group.positions.length);
      const m = new THREE.Matrix4();
      for (let i = 0; i < group.positions.length; i++) {
        const p = group.positions[i];
        m.setPosition(p.x, p.y, p.z);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
    }
    const maxDim = Math.max(data.width, data.height, data.length);
    camera.position.set(maxDim * 0.9, maxDim * 0.65, maxDim * 0.9);
    camera.lookAt(0, data.height / 3, 0);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, data.height / 3, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.update();
    addEventListener('resize', () => {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    });
    function animate() { requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); }
    animate();
  </script>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html' });
  downloadBlob(blob, filename);
}
