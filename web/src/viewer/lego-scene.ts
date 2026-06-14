/**
 * LEGO-optimised Three.js viewer for BlockGrid schematics.
 *
 * Renders blocks as smooth plastic-coloured cubes scaled to real LEGO
 * proportions, not Minecraft-textured voxels. Designed for the showcase page.
 *
 * Y-axis scaling:
 *   Accurate mode: 1 Y cell = 1 plate = 8 LDU; 1 XZ cell = 1 stud = 20 LDU
 *   → yScale = 8/20 = 0.4  (real plate proportions)
 *   Cubic mode:    yScale = 1.0  (cube cells)
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BlockGrid } from '@craft/schem/types.js';
import { getBlockColor } from '@craft/blocks/colors.js';
import { isAir } from '@craft/blocks/registry.js';
import type { ViewerState } from './scene.js';

export type { ViewerState } from './scene.js';

/**
 * Y scale for accurate-mode grids.
 * Real LEGO plate height (8 LDU) / stud pitch (20 LDU) = 0.4.
 */
export const ACCURATE_Y_SCALE = 8 / 20;

// ─── LEGO plastic texture ────────────────────────────────────────────────────

const legoTexCache = new Map<number, THREE.CanvasTexture>();

function rgbKey(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

/**
 * Generate a plastic LEGO face texture: flat colour + subtle stud circle +
 * bevelled edge darkening. Applied to all six faces of the block geometry.
 */
function makeLegoTexture(r: number, g: number, b: number): THREE.CanvasTexture {
  const key = rgbKey(r, g, b);
  const cached = legoTexCache.get(key);
  if (cached) return cached;

  const S = 64;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d')!;

  // ── Base fill ────────────────────────────────────────────────────────────
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, S, S);

  // ── Stud disc ────────────────────────────────────────────────────────────
  // Mimics the hollow LEGO stud seen on all faces (top = stud; sides = tube)
  const cx = S * 0.5, cy = S * 0.5, outerR = S * 0.285;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

  // Outer shadow ring
  ctx.fillStyle = `rgb(${clamp(r*0.65)},${clamp(g*0.65)},${clamp(b*0.65)})`;
  ctx.beginPath(); ctx.arc(cx, cy, outerR, 0, Math.PI * 2); ctx.fill();

  // Stud body (base colour)
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.beginPath(); ctx.arc(cx, cy, outerR * 0.80, 0, Math.PI * 2); ctx.fill();

  // Top-left highlight (plastic specular)
  const hl = `rgb(${clamp(r*1.28+30)},${clamp(g*1.28+30)},${clamp(b*1.28+30)})`;
  ctx.fillStyle = hl;
  ctx.beginPath();
  ctx.arc(cx - outerR * 0.18, cy - outerR * 0.18, outerR * 0.42, 0, Math.PI * 2);
  ctx.fill();

  // Glint
  ctx.fillStyle = 'rgba(255,255,255,0.32)';
  ctx.beginPath();
  ctx.arc(cx - outerR * 0.30, cy - outerR * 0.30, outerR * 0.20, 0, Math.PI * 2);
  ctx.fill();

  // ── Bevel ────────────────────────────────────────────────────────────────
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  const bev = 2;
  for (let x = 0; x < S; x++) {
    for (let y = 0; y < S; y++) {
      if (x < bev || y < bev || x >= S - bev || y >= S - bev) {
        const i = (y * S + x) * 4;
        d[i]   = Math.max(0, d[i]   - 40);
        d[i+1] = Math.max(0, d[i+1] - 40);
        d[i+2] = Math.max(0, d[i+2] - 40);
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  legoTexCache.set(key, tex);
  return tex;
}

// ─── Viewer options ──────────────────────────────────────────────────────────

export interface LegoViewerOptions {
  /**
   * Y-axis scale applied to block height and Y positions.
   * Use ACCURATE_Y_SCALE (0.4) for accurate-mode grids; 1.0 for cubic.
   */
  yScale?: number;
}

// ─── Main viewer factory ──────────────────────────────────────────────────────

export function createLegoViewer(
  container: HTMLElement,
  grid: BlockGrid,
  options: LegoViewerOptions = {},
): ViewerState {
  const { width, height, length } = grid;
  const yScale = options.yScale ?? 1;

  // ── Scene ─────────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12121c);

  // ── Camera ────────────────────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.1,
    5000,
  );

  // ── Renderer ──────────────────────────────────────────────────────────────
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch {
    const msg = document.createElement('div');
    msg.style.cssText =
      'display:flex;align-items:center;justify-content:center;width:100%;height:100%;' +
      'color:#999;font:14px/1.4 system-ui;text-align:center;padding:1em;';
    msg.textContent = '3D viewer requires WebGL.';
    container.appendChild(msg);
    return {
      scene, camera,
      renderer: null as unknown as THREE.WebGLRenderer,
      controls: null as unknown as OrbitControls,
      meshes: [], grid,
      dispose: () => msg.remove(),
    };
  }

  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  container.appendChild(renderer.domElement);

  // ── Lighting (product-photography 3-point) ────────────────────────────────
  // Key: strong warm top-front-left
  const key = new THREE.DirectionalLight(0xfff5e8, 3.0);
  key.position.set(-50, 90, 70);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const shadowRange = Math.max(width, length) * 0.9;
  key.shadow.camera.left   = -shadowRange;
  key.shadow.camera.right  =  shadowRange;
  key.shadow.camera.top    =  shadowRange;
  key.shadow.camera.bottom = -shadowRange;
  key.shadow.bias = -0.0008;
  scene.add(key);

  // Fill: soft cool top-right
  const fill = new THREE.DirectionalLight(0xd8eeff, 1.1);
  fill.position.set(70, 50, -40);
  scene.add(fill);

  // Rim: cool back-bottom for depth separation
  const rim = new THREE.DirectionalLight(0x4466bb, 0.55);
  rim.position.set(0, -30, -90);
  scene.add(rim);

  // Hemisphere: sky/ground ambient
  scene.add(new THREE.HemisphereLight(0xffffff, 0x223322, 0.7));

  // ── LEGO baseplate ────────────────────────────────────────────────────────
  const baseH = 0.25;
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(width + 8, baseH, length + 8),
    new THREE.MeshStandardMaterial({ color: 0x1a6826, roughness: 0.75, metalness: 0 }),
  );
  plate.position.set(0, -baseH / 2, 0);
  plate.receiveShadow = true;
  scene.add(plate);

  // ── Build instanced meshes ─────────────────────────────────────────────────
  // Each distinct (r,g,b) colour → one InstancedMesh.
  interface Entry { x: number; y: number; z: number; r: number; g: number; b: number }
  const colourGroups = new Map<number, Entry[]>();

  const halfW = width  / 2;
  const halfL = length / 2;

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const bs = grid.get(x, y, z);
        if (isAir(bs)) continue;
        const colour = getBlockColor(bs);
        if (!colour) continue;
        const [r, g, b] = colour;
        const key2 = rgbKey(r, g, b);
        if (!colourGroups.has(key2)) colourGroups.set(key2, []);
        colourGroups.get(key2)!.push({ x, y, z, r, g, b });
      }
    }
  }

  // Block geometry scaled to correct LEGO proportions:
  //   XZ = 0.96 (slight gap to see individual bricks)
  //   Y  = 0.96 × yScale
  const GX = 0.96, GZ = 0.96, GY = 0.96 * yScale;
  const geo = new THREE.BoxGeometry(GX, GY, GZ);

  const meshes: THREE.InstancedMesh[] = [];
  const m4 = new THREE.Matrix4();

  for (const [, entries] of colourGroups) {
    const { r, g, b } = entries[0];
    const tex = makeLegoTexture(r, g, b);

    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.22,
      metalness: 0.04,
    });

    const mesh = new THREE.InstancedMesh(geo, mat, entries.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    for (let i = 0; i < entries.length; i++) {
      const { x, y: gy, z } = entries[i];
      // Y position scaled so plate spacing matches real LEGO proportions
      m4.identity();
      m4.setPosition(x - halfW, gy * yScale, z - halfL);
      mesh.setMatrixAt(i, m4);
    }

    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    scene.add(mesh);
    meshes.push(mesh);
  }

  // ── Camera + OrbitControls ────────────────────────────────────────────────
  const scaledH = height * yScale;
  const maxDim  = Math.max(width, scaledH, length);
  const dist    = maxDim * 1.15;

  camera.position.set(dist * 0.80, dist * 0.60, dist * 0.80);
  camera.lookAt(0, scaledH * 0.45, 0);

  let controls!: OrbitControls;
  let animId = 0;

  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    cancelAnimationFrame(animId);
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    animate();
  });

  function animate() {
    animId = requestAnimationFrame(animate);
    controls?.update();
    renderer.render(scene, camera);
  }

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, scaledH * 0.45, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.maxDistance   = maxDim * 4;
  controls.update();

  animate();

  // ── Resize ────────────────────────────────────────────────────────────────
  const ro = new ResizeObserver(() => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  ro.observe(container);

  // ── Dispose ───────────────────────────────────────────────────────────────
  function dispose() {
    cancelAnimationFrame(animId);
    ro.disconnect();
    controls.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    geo.dispose();
    meshes.forEach(m => {
      (m.material as THREE.MeshStandardMaterial).map?.dispose();
      (m.material as THREE.MeshStandardMaterial).dispose();
      m.dispose();
    });
    legoTexCache.clear();
  }

  return { scene, camera, renderer, controls, meshes, grid, dispose };
}
