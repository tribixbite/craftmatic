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
 * Real-world export scale. The viewer works in scene units where 1 unit =
 * 1 stud = 20 LDU = 8 mm. STL/OBJ are unitless and every slicer assumes mm,
 * so we bake printing exports at 8 mm/stud → the print comes out at TRUE LEGO
 * size (not 1/8 scale, which is what 1 unit = 1 mm would give). GLB stays in
 * scene units (glTF viewers fit-to-view; changing it would surprise Blender
 * import workflows). 20248-stud Hogwarts won't fit a consumer bed at this
 * scale — the user rescales in their slicer, but the default is meaningful.
 */
export const EXPORT_MM_PER_STUD = 8;

/** Minimum viewer surface an exportable mesh must expose. */
export interface ExportMeshLike {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  userData: { originalMatrices?: THREE.Matrix4[] };
  /** Present on THREE.InstancedMesh when per-instance colors were set. */
  instanceColor?: THREE.InstancedBufferAttribute | null;
  /** THREE.InstancedMesh color accessor (paired with instanceColor). */
  getColorAt?(index: number, color: THREE.Color): void;
}

/**
 * Bake InstancedMesh instances into a flat Group of plain Meshes suitable for
 * export. Three's STL/GLTF/OBJ exporters don't handle InstancedMesh, so each
 * instance becomes its own Mesh at its assembled (pre-explode) world matrix.
 * `scale` applies a uniform real-world scale (see EXPORT_MM_PER_STUD).
 *
 * Per-instance colors: the renderer multiplies instanceColor with
 * material.color in the shader, so instances that share one material can
 * still show distinct colors on screen. A naive bake that reuses the shared
 * material loses all of that in GLB/OBJ — so when instanceColor exists, the
 * effective (material × instance) color is baked into a material CLONED per
 * unique color, cached by hex. Identity tints (white) reuse the original.
 *
 * IMPORTANT: updateMatrixWorld(true) so exporters reading matrixWorld see the
 * correct positions (and the group scale).
 */
function bakeInstances(meshes: readonly ExportMeshLike[], scale: number): { group: THREE.Group; cleanup: () => void } {
  const group = new THREE.Group();
  const tempMeshes: THREE.Mesh[] = [];
  const clonedMaterials: THREE.Material[] = [];
  const tmpColor = new THREE.Color();

  for (const instMesh of meshes) {
    const originals = instMesh.userData.originalMatrices;
    if (!originals) continue;

    // Per-instance color baking is only possible for a single material that
    // actually has a .color (MeshStandard/Physical/Basic…); material arrays
    // and colorless materials fall back to the shared-material path.
    const baseMat = Array.isArray(instMesh.material) ? null : instMesh.material;
    const baseColor = baseMat && 'color' in baseMat && (baseMat as THREE.MeshStandardMaterial).color instanceof THREE.Color
      ? (baseMat as THREE.MeshStandardMaterial).color
      : null;
    const bakeColors = !!(instMesh.instanceColor && instMesh.getColorAt && baseMat && baseColor);
    const baseHex = baseColor?.getHexString();
    const matByHex = new Map<string, THREE.Material>();

    for (let i = 0; i < originals.length; i++) {
      const matrix = originals[i]!;
      let material: THREE.Material | THREE.Material[] = instMesh.material;
      if (bakeColors) {
        instMesh.getColorAt!(i, tmpColor);
        const effective = tmpColor.clone().multiply(baseColor!);
        const hex = effective.getHexString();
        if (hex !== baseHex) {
          let m = matByHex.get(hex);
          if (!m) {
            m = baseMat!.clone();
            (m as THREE.MeshStandardMaterial).color.copy(effective);
            matByHex.set(hex, m);
            clonedMaterials.push(m);
          }
          material = m;
        }
      }
      const mesh = new THREE.Mesh(instMesh.geometry, material);
      mesh.applyMatrix4(matrix);
      group.add(mesh);
      tempMeshes.push(mesh);
    }
  }

  if (scale !== 1) group.scale.setScalar(scale);
  group.updateMatrixWorld(true);

  return {
    group,
    cleanup: () => {
      for (const m of tempMeshes) {
        m.geometry = undefined!; // shared geometry — don't dispose
        group.remove(m);
      }
      for (const m of clonedMaterials) m.dispose(); // per-color clones are export-only
    },
  };
}

/** Total triangle count an export will bake (instances × per-part tris). */
export function countExportTriangles(meshes: readonly ExportMeshLike[]): number {
  let tris = 0;
  for (const m of meshes) {
    const n = m.userData.originalMatrices?.length ?? 0;
    if (!n) continue;
    const g = m.geometry;
    const perPart = (g.index ? g.index.count : g.attributes['position']?.count ?? 0) / 3;
    tris += perPart * n;
  }
  return tris;
}

// ── Pure, download-free export cores (node-testable; see test/mesh-export.test.ts) ──

/** Bake instances → binary STL bytes at real-world mm scale.
 *  STL stays geometry-only — the format has no color/material channel, so
 *  per-brick colors are intentionally not carried (use GLB/OBJ for color). */
export async function meshesToStlBinary(meshes: readonly ExportMeshLike[], scale = EXPORT_MM_PER_STUD): Promise<ArrayBuffer> {
  const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js');
  const { group, cleanup } = bakeInstances(meshes, scale);
  const result = new STLExporter().parse(group, { binary: true }) as unknown as DataView;
  cleanup();
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
}

/** Bake instances → OBJ text at real-world mm scale. */
export async function meshesToObj(meshes: readonly ExportMeshLike[], scale = EXPORT_MM_PER_STUD): Promise<string> {
  const { OBJExporter } = await import('three/examples/jsm/exporters/OBJExporter.js');
  const { group, cleanup } = bakeInstances(meshes, scale);
  const result = new OBJExporter().parse(group);
  cleanup();
  return result;
}

/** Export the current Three.js scene as GLB (binary glTF, scene units / studs). */
export async function exportGLB(viewer: ViewerState, filename = 'craftmatic.glb'): Promise<void> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const exporter = new GLTFExporter();
  // GLB keeps scene units (1 unit = 1 stud); glTF viewers fit-to-view.
  const { group, cleanup } = bakeInstances(viewer.meshes as unknown as ExportMeshLike[], 1);

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

/** Export the current Three.js scene as binary STL (3D printing, real-world mm). */
export async function exportSTL(viewer: ViewerState, filename = 'craftmatic.stl'): Promise<void> {
  const bytes = await meshesToStlBinary(viewer.meshes as unknown as ExportMeshLike[]);
  downloadBlob(new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' }), filename);
}

/** Export the current Three.js scene as OBJ (universal 3D format, real-world mm). */
export async function exportOBJ(viewer: ViewerState, filename = 'craftmatic.obj'): Promise<void> {
  const text = await meshesToObj(viewer.meshes as unknown as ExportMeshLike[]);
  downloadBlob(new Blob([text], { type: 'text/plain' }), filename);
}

/** Export the BlockGrid as a .schem file */
export function exportSchem(grid: BlockGrid, filename = 'craftmatic.schem'): void {
  // Delegate to the single validated encoder (test/schem-export.test.ts) so the
  // downloaded file is byte-identical to the server-receiver path — no second
  // hand-written NBT implementation to drift out of spec.
  const blob = new Blob([encodeSchemBytes(grid) as unknown as BlobPart], { type: 'application/octet-stream' });
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

  // NBT tag type constants (TAG_BYTE omitted — unused by this writer)
  const TAG_INT = 3, TAG_LONG = 4, TAG_STRING = 8;
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

// ── Block palette for layer guide ──────────────────────────────────────────

const LAYER_GUIDE_HEX: Record<string, string> = {
  'minecraft:black_concrete':           '#080a0f',
  'minecraft:blue_concrete':            '#2c2e8f',
  'minecraft:green_concrete':           '#495b24',
  'minecraft:cyan_concrete':            '#157788',
  'minecraft:red_concrete':             '#8e2121',
  'minecraft:magenta_concrete':         '#a9309f',
  'minecraft:brown_concrete':           '#603b1f',
  'minecraft:light_gray_concrete':      '#7d7d73',
  'minecraft:gray_concrete':            '#373a3e',
  'minecraft:light_blue_concrete':      '#2489c7',
  'minecraft:lime_concrete':            '#5ea818',
  'minecraft:pink_concrete':            '#d5658f',
  'minecraft:yellow_concrete':          '#f0af15',
  'minecraft:white_concrete':           '#cfd5d6',
  'minecraft:orange_concrete':          '#e06100',
  'minecraft:purple_concrete':          '#64209c',
  'minecraft:sandstone':                '#d8c794',
  'minecraft:glass':                    '#afd5e4',
  'minecraft:lime_stained_glass':       '#80c71f',
  'minecraft:red_stained_glass':        '#993333',
  'minecraft:blue_stained_glass':       '#4040ff',
  'minecraft:yellow_stained_glass':     '#e5e533',
  'minecraft:purple_stained_glass':     '#7f3fb2',
  'minecraft:orange_stained_glass':     '#d87f33',
  'minecraft:green_stained_glass':      '#667f33',
  'minecraft:gray_stained_glass':       '#4c4c4c',
  'minecraft:light_blue_stained_glass': '#6699d8',
  'minecraft:pink_stained_glass':       '#f27fa5',
  'minecraft:cyan_stained_glass':       '#4c7f99',
};

/**
 * Export a layer-by-layer building guide as a standalone HTML file.
 * Each Y-level is rendered as a canvas grid (top-down view, X × Z).
 * Open in browser and Print → Save as PDF.
 */
export function exportLayerGuide(grid: BlockGrid, label: string, filename = 'layer-guide.html'): void {
  const { width: W, height: H, length: L } = grid;

  // Build indexed palette
  const nameToIdx = new Map<string, number>();
  const palette: string[] = [];
  const paletteFriendly: string[] = []; // short display name

  function blockIdx(block: string): number {
    const key = block.split('[')[0]!;
    let idx = nameToIdx.get(key);
    if (idx === undefined) {
      idx = palette.length;
      nameToIdx.set(key, idx);
      palette.push(LAYER_GUIDE_HEX[key] ?? '#969696');
      paletteFriendly.push(key.replace('minecraft:', '').replace(/_/g, ' '));
    }
    return idx;
  }

  // Build layer data: each layer is [x, z, colorIdx][] (air omitted)
  const layers: Array<[number, number, number][]> = [];
  const totals: number[] = []; // count per palette index

  for (let y = 0; y < H; y++) {
    const cells: [number, number, number][] = [];
    for (let x = 0; x < W; x++) {
      for (let z = 0; z < L; z++) {
        const b = grid.get(x, y, z);
        if (b === 'minecraft:air') continue;
        const ci = blockIdx(b);
        cells.push([x, z, ci]);
        totals[ci] = (totals[ci] ?? 0) + 1;
      }
    }
    layers.push(cells);
  }

  // Sort palette by usage for legend
  const legendOrder = palette.map((_, i) => i).sort((a, b) => (totals[b] ?? 0) - (totals[a] ?? 0));

  const dataJs = `const W=${W},H=${H},L=${L};
const PALETTE=${JSON.stringify(palette)};
const NAMES=${JSON.stringify(paletteFriendly)};
const TOTALS=${JSON.stringify(totals.map(t => t ?? 0))};
const LEGEND_ORDER=${JSON.stringify(legendOrder)};
const LAYERS=${JSON.stringify(layers)};
const LABEL=${JSON.stringify(label)};`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Building Guide — ${label}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#fff;color:#111;padding:20px}
h1{font-size:1.4rem;margin-bottom:4px}
.meta{font-size:.85rem;color:#555;margin-bottom:16px}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-bottom:20px}
.legend-item{display:flex;align-items:center;gap:5px;font-size:.75rem}
.swatch{width:14px;height:14px;border:1px solid rgba(0,0,0,.15);border-radius:2px;flex-shrink:0}
.layers{display:flex;flex-wrap:wrap;gap:12px 16px}
.layer-block{break-inside:avoid}
.layer-label{font-size:.7rem;color:#666;margin-bottom:2px}
canvas{display:block;image-rendering:pixelated;border:1px solid #e0e0e0}
@media print{
  body{padding:8px}
  .legend{margin-bottom:12px}
  .layers{gap:8px 12px}
}
.bom{margin:20px 0 24px}
.bom h2{font-size:1rem;margin-bottom:8px}
.bom table{border-collapse:collapse;font-size:.8rem}
.bom td,.bom th{padding:3px 10px 3px 4px;text-align:left}
.bom th{border-bottom:1px solid #ccc;font-weight:600}
.bom .bom-swatch{width:14px;height:14px;border:1px solid rgba(0,0,0,.15);border-radius:2px;display:inline-block;vertical-align:middle;margin-right:4px}
@media print{.bom{margin:12px 0 16px}}
</style>
</head>
<body>
<h1 id="title"></h1>
<div class="meta" id="meta"></div>
<div class="legend" id="legend"></div>
<div class="bom" id="bom"></div>
<div class="layers" id="layers"></div>
<script>
${dataJs}

// Determine cell size: target ~480px max canvas dimension, min 3px
const CELL = Math.max(3, Math.min(12, Math.floor(480 / Math.max(W, L))));

document.getElementById('title').textContent = LABEL + ' — Building Guide';
document.getElementById('meta').textContent =
  W + '×' + H + '×' + L + ' blocks  •  ' +
  TOTALS.reduce((a,b)=>a+b,0).toLocaleString() + ' total blocks  •  ' +
  palette.length + ' block types';

// Legend
const lgEl = document.getElementById('legend');
for (const ci of LEGEND_ORDER) {
  const div = document.createElement('div');
  div.className = 'legend-item';
  const sw = document.createElement('div');
  sw.className = 'swatch';
  sw.style.background = PALETTE[ci];
  const lbl = document.createElement('span');
  lbl.textContent = NAMES[ci] + ' (' + (TOTALS[ci]||0).toLocaleString() + ')';
  div.appendChild(sw);
  div.appendChild(lbl);
  lgEl.appendChild(div);
}

// BOM table
const bomEl = document.getElementById('bom');
const bomH2 = document.createElement('h2');
bomH2.textContent = 'Bill of Materials';
bomEl.appendChild(bomH2);
const tbl = document.createElement('table');
const hdr = tbl.createTHead().insertRow();
['Block','Count'].forEach(t => { const th=document.createElement('th'); th.textContent=t; hdr.appendChild(th); });
const tbody = tbl.createTBody();
const grand = TOTALS.reduce((a,b)=>a+b,0);
for (const ci of LEGEND_ORDER) {
  const tr = tbody.insertRow();
  const td0 = tr.insertCell();
  const sw = document.createElement('span');
  sw.className = 'bom-swatch';
  sw.style.background = PALETTE[ci];
  td0.appendChild(sw);
  td0.appendChild(document.createTextNode(NAMES[ci]));
  const td1 = tr.insertCell();
  td1.textContent = (TOTALS[ci]||0).toLocaleString();
  td1.style.textAlign = 'right';
}
const tftr = tbl.createTFoot().insertRow();
const tdl = tftr.insertCell(); tdl.textContent = 'Total';
tftr.insertCell().textContent = grand.toLocaleString();
tftr.style.fontWeight = '600';
bomEl.appendChild(tbl);

// Layers (bottom to top)
const layersEl = document.getElementById('layers');
for (let y = 0; y < H; y++) {
  const block = document.createElement('div');
  block.className = 'layer-block';
  const lbl = document.createElement('div');
  lbl.className = 'layer-label';
  lbl.textContent = 'Layer ' + (y + 1) + ' (Y=' + y + ')';
  const cvs = document.createElement('canvas');
  cvs.width = W * CELL;
  cvs.height = L * CELL;
  const ctx = cvs.getContext('2d');
  ctx.fillStyle = '#f4f4f4';
  ctx.fillRect(0, 0, cvs.width, cvs.height);
  for (const [x, z, ci] of LAYERS[y]) {
    ctx.fillStyle = PALETTE[ci];
    ctx.fillRect(x * CELL, z * CELL, CELL, CELL);
  }
  block.appendChild(lbl);
  block.appendChild(cvs);
  layersEl.appendChild(block);
}
</script>
</body>
</html>`;

  downloadBlob(new Blob([html], { type: 'text/html' }), filename);
}
