/**
 * Export utilities: GLB, .schem, and standalone HTML.
 */

import * as THREE from 'three';
import pako from 'pako';
import type { ViewerState } from './scene.js';
import { BlockGrid } from '@craft/schem/types.js';

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

/** Export the current Three.js scene as GLB (binary glTF) */
export async function exportGLB(viewer: ViewerState, filename = 'craftmatic.glb'): Promise<void> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const exporter = new GLTFExporter();

  return new Promise((resolve, reject) => {
    exporter.parse(
      viewer.scene,
      (result) => {
        const blob = new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
        downloadBlob(blob, filename);
        resolve();
      },
      (error) => reject(error),
      { binary: true }
    );
  });
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
