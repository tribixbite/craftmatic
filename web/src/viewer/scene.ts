/**
 * Three.js 3D viewer for BlockGrid schematics.
 * Creates an interactive scene with textured blocks, non-cube geometries,
 * and Faithful 32x texture loading with procedural fallback.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BlockGrid } from '@craft/schem/types.js';
import { getBlockColor } from '@craft/blocks/colors.js';
import { isAir, isSolidBlock, getBlockName, getFacing } from '@craft/blocks/registry.js';
import type { RGB } from '@craft/types/index.js';

export interface ViewerState {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  meshes: THREE.InstancedMesh[];
  grid: BlockGrid;
  dispose: () => void;
}

// ─── Geometry Types ─────────────────────────────────────────────────────────

type GeometryKind = 'cube' | 'slab' | 'carpet' | 'fence' | 'torch' | 'lantern'
  | 'chain' | 'door' | 'pane' | 'rod';

/** Determine the geometry type for a block */
function getGeometryKind(name: string): GeometryKind {
  if (name.includes('carpet') || name.includes('moss_carpet')) return 'carpet';
  if (name.includes('_slab')) return 'slab';
  if (name.includes('_fence') && !name.includes('gate')) return 'fence';
  if (name.includes('torch') && !name.includes('redstone')) return 'torch';
  if (name === 'lantern' || name === 'soul_lantern') return 'lantern';
  if (name === 'chain') return 'chain';
  if (name.includes('_door')) return 'door';
  if (name.includes('_pane') || name === 'iron_bars') return 'pane';
  if (name === 'end_rod' || name === 'lightning_rod') return 'rod';
  return 'cube';
}

/** Geometry cache by kind */
const geoCache = new Map<GeometryKind, THREE.BufferGeometry>();

/** Get or create geometry for a block kind */
function getGeometry(kind: GeometryKind): THREE.BufferGeometry {
  if (geoCache.has(kind)) return geoCache.get(kind)!;
  let geo: THREE.BufferGeometry;
  switch (kind) {
    case 'slab':
      geo = new THREE.BoxGeometry(1, 0.5, 1);
      geo.translate(0, -0.25, 0);
      break;
    case 'carpet':
      geo = new THREE.BoxGeometry(1, 0.0625, 1);
      geo.translate(0, -0.47, 0);
      break;
    case 'fence':
      geo = new THREE.BoxGeometry(0.25, 1, 0.25);
      break;
    case 'torch':
      geo = new THREE.BoxGeometry(0.15, 0.6, 0.15);
      geo.translate(0, -0.2, 0);
      break;
    case 'lantern':
      geo = new THREE.BoxGeometry(0.35, 0.4, 0.35);
      geo.translate(0, -0.1, 0);
      break;
    case 'chain':
      geo = new THREE.BoxGeometry(0.1, 1, 0.1);
      break;
    case 'door':
      geo = new THREE.BoxGeometry(1, 1, 0.2);
      break;
    case 'pane':
      geo = new THREE.BoxGeometry(0.1, 1, 1);
      break;
    case 'rod':
      geo = new THREE.BoxGeometry(0.12, 1, 0.12);
      break;
    default:
      geo = new THREE.BoxGeometry(1, 1, 1);
      break;
  }
  geoCache.set(kind, geo);
  return geo;
}

// ─── Texture System ─────────────────────────────────────────────────────────

/** Seeded RNG for procedural textures */
function createRng(r: number, g: number, b: number): () => number {
  let seed = (r * 7919 + g * 6271 + b * 4447) | 0;
  return () => { seed = (seed * 16807 + 1) % 2147483647; return seed / 2147483647; };
}

/** Load real texture PNGs from textures/blocks/ via Vite glob import */
const textureImages: Record<string, string> = import.meta.glob(
  '../../../textures/blocks/*.png',
  { eager: true, import: 'default', query: '?url' },
) as Record<string, string>;

/** Normalize glob paths to texture names */
const textureUrlMap = new Map<string, string>();
for (const [path, url] of Object.entries(textureImages)) {
  const name = path.split('/').pop()?.replace('.png', '') ?? '';
  if (name) textureUrlMap.set(name, url);
}

/** Cache for loaded THREE.Texture objects */
const loadedTextures = new Map<string, THREE.Texture>();

/** Load a real PNG texture or fall back to procedural */
function loadBlockTexture(blockName: string, r: number, g: number, b: number): THREE.Texture {
  // Try real texture first
  const url = textureUrlMap.get(blockName);
  if (url) {
    if (loadedTextures.has(blockName)) return loadedTextures.get(blockName)!;
    const tex = new THREE.TextureLoader().load(url);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    loadedTextures.set(blockName, tex);
    return tex;
  }

  // Fall back to procedural texture
  return makeProceduralTexture(r, g, b, blockName);
}

/** Generate a procedural block texture on a Canvas (fallback) */
function makeProceduralTexture(r: number, g: number, b: number, blockName: string): THREE.CanvasTexture {
  const size = 32;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, size, size);
  const imgData = ctx.getImageData(0, 0, size, size);
  const d = imgData.data;

  const rand = createRng(r, g, b);
  const name = blockName;

  if (name.includes('planks') || name.includes('door') || name.includes('trapdoor')) {
    for (let y = 0; y < size; y++) {
      const lineVar = (rand() - 0.5) * 16;
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const grain = Math.sin(y * 0.6 + rand() * 0.3) * 8 + lineVar * 0.3;
        d[idx] = Math.max(0, Math.min(255, d[idx] + grain + (rand() - 0.5) * 6));
        d[idx+1] = Math.max(0, Math.min(255, d[idx+1] + grain + (rand() - 0.5) * 6));
        d[idx+2] = Math.max(0, Math.min(255, d[idx+2] + grain * 0.5 + (rand() - 0.5) * 4));
      }
    }
    for (let x = 0; x < size; x++) {
      if (x % 8 === 0) {
        for (let y = 0; y < size; y++) {
          const idx = (y * size + x) * 4;
          d[idx] = Math.max(0, d[idx] - 18);
          d[idx+1] = Math.max(0, d[idx+1] - 18);
          d[idx+2] = Math.max(0, d[idx+2] - 12);
        }
      }
    }
  } else if (name.includes('log') || name.includes('wood') || name.includes('stem')) {
    for (let x = 0; x < size; x++) {
      const streak = (rand() - 0.5) * 22;
      for (let y = 0; y < size; y++) {
        const idx = (y * size + x) * 4;
        const bark = streak + (rand() - 0.5) * 10;
        d[idx] = Math.max(0, Math.min(255, d[idx] + bark));
        d[idx+1] = Math.max(0, Math.min(255, d[idx+1] + bark));
        d[idx+2] = Math.max(0, Math.min(255, d[idx+2] + bark * 0.7));
      }
    }
  } else if (name.includes('stone') || name.includes('cobble') || name.includes('andesite')
              || name.includes('diorite') || name.includes('granite') || name.includes('deepslate')
              || name.includes('blackstone') || name.includes('tuff')) {
    for (let i = 0; i < d.length; i += 4) {
      const n = (rand() - 0.5) * 28;
      d[i] = Math.max(0, Math.min(255, d[i] + n));
      d[i+1] = Math.max(0, Math.min(255, d[i+1] + n));
      d[i+2] = Math.max(0, Math.min(255, d[i+2] + n * 0.8));
    }
    for (let i = 0; i < 5; i++) {
      const sx = Math.floor(rand() * size);
      const sy = Math.floor(rand() * size);
      const len = 4 + Math.floor(rand() * 8);
      for (let j = 0; j < len; j++) {
        const px = Math.min(size-1, sx + j);
        const py = Math.min(size-1, sy + Math.floor(rand() * 2));
        const idx = (py * size + px) * 4;
        d[idx] = Math.max(0, d[idx] - 25);
        d[idx+1] = Math.max(0, d[idx+1] - 25);
        d[idx+2] = Math.max(0, d[idx+2] - 20);
      }
    }
  } else if (name.includes('brick')) {
    for (let y = 0; y < size; y++) {
      const row = Math.floor(y / 8);
      const offset = (row % 2) * 8;
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const isMortar = (y % 8 <= 1) || ((x + offset) % 16 === 0 && y % 8 > 1);
        if (isMortar) {
          d[idx] = Math.max(0, d[idx] - 30);
          d[idx+1] = Math.max(0, d[idx+1] - 25);
          d[idx+2] = Math.max(0, d[idx+2] - 20);
        } else {
          const n = (rand() - 0.5) * 12;
          d[idx] = Math.max(0, Math.min(255, d[idx] + n));
          d[idx+1] = Math.max(0, Math.min(255, d[idx+1] + n * 0.7));
          d[idx+2] = Math.max(0, Math.min(255, d[idx+2] + n * 0.5));
        }
      }
    }
  } else if (name.includes('glass')) {
    for (let i = 0; i < d.length; i += 4) d[i+3] = 180;
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        const idx = (y * size + x) * 4;
        if (x <= 1 || y <= 1) {
          d[idx] = Math.min(255, d[idx] + 50);
          d[idx+1] = Math.min(255, d[idx+1] + 50);
          d[idx+2] = Math.min(255, d[idx+2] + 50);
          d[idx+3] = 220;
        }
      }
    }
  } else if (name.includes('wool') || name.includes('carpet') || name.includes('concrete')) {
    for (let i = 0; i < d.length; i += 4) {
      const n = (rand() - 0.5) * 8;
      d[i] = Math.max(0, Math.min(255, d[i] + n));
      d[i+1] = Math.max(0, Math.min(255, d[i+1] + n));
      d[i+2] = Math.max(0, Math.min(255, d[i+2] + n));
    }
  } else if (name.includes('quartz') || name.includes('smooth')) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const n = (rand() - 0.5) * 6 + Math.sin(y * 0.25) * 3;
        d[idx] = Math.max(0, Math.min(255, d[idx] + n));
        d[idx+1] = Math.max(0, Math.min(255, d[idx+1] + n));
        d[idx+2] = Math.max(0, Math.min(255, d[idx+2] + n));
      }
    }
  } else {
    for (let i = 0; i < d.length; i += 4) {
      const n = (rand() - 0.5) * 14;
      d[i] = Math.max(0, Math.min(255, d[i] + n));
      d[i+1] = Math.max(0, Math.min(255, d[i+1] + n));
      d[i+2] = Math.max(0, Math.min(255, d[i+2] + n));
    }
  }

  // Edge darkening for non-transparent blocks
  if (!name.includes('glass') && !name.includes('pane') && !name.includes('bars')
      && !name.includes('torch') && !name.includes('lantern')) {
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        if (x <= 1 || y <= 1 || x >= size-2 || y >= size-2) {
          const idx = (y * size + x) * 4;
          d[idx] = Math.max(0, d[idx] - 15);
          d[idx+1] = Math.max(0, d[idx+1] - 15);
          d[idx+2] = Math.max(0, d[idx+2] - 15);
        }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ─── Scene Builder ──────────────────────────────────────────────────────────

/** Check if a block is fully surrounded by solid blocks (occlusion culling) */
function isFullyOccluded(grid: BlockGrid, x: number, y: number, z: number): boolean {
  return (
    isSolidBlock(grid.get(x + 1, y, z)) &&
    isSolidBlock(grid.get(x - 1, y, z)) &&
    isSolidBlock(grid.get(x, y + 1, z)) &&
    isSolidBlock(grid.get(x, y - 1, z)) &&
    isSolidBlock(grid.get(x, y, z + 1)) &&
    isSolidBlock(grid.get(x, y, z - 1))
  );
}

/** Get rotation angle in radians for a facing direction */
function facingToAngle(facing: string | null): number {
  switch (facing) {
    case 'east': return Math.PI / 2;
    case 'south': return Math.PI;
    case 'west': return -Math.PI / 2;
    default: return 0; // north or no facing
  }
}

/** Build a Three.js scene from a BlockGrid and mount it on a container element */
export function createViewer(container: HTMLElement, grid: BlockGrid): ViewerState {
  const { width, height, length } = grid;

  // Scene setup
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);
  scene.fog = new THREE.FogExp2(0x1a1a2e, 0.006);

  const camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 1000);

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  } catch {
    // WebGL not available — show fallback message
    const fallback = document.createElement('div');
    fallback.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:#999;font:14px/1.4 system-ui;text-align:center;padding:1em;';
    fallback.textContent = '3D viewer requires WebGL. Try a different browser or enable hardware acceleration.';
    container.appendChild(fallback);
    // Return a no-op viewer state
    return {
      scene, camera,
      renderer: null as unknown as THREE.WebGLRenderer,
      controls: null as unknown as OrbitControls,
      meshes: [], grid,
      dispose: () => { fallback.remove(); },
    };
  }

  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  container.appendChild(renderer.domElement);

  // Render loop (declared early for context loss handler)
  let animId = 0;
  let controls: OrbitControls;
  function animate() {
    animId = requestAnimationFrame(animate);
    controls?.update();
    renderer.render(scene, camera);
  }

  // Handle WebGL context loss gracefully
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    cancelAnimationFrame(animId);
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    animate();
  });

  // Lighting
  scene.add(new THREE.AmbientLight(0x606080, 0.5));
  scene.add(new THREE.HemisphereLight(0x87ceeb, 0x443322, 0.6));

  const sun = new THREE.DirectionalLight(0xfff0dd, 1.8);
  sun.position.set(40, 60, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const shadowRange = Math.max(width, length) * 0.8;
  sun.shadow.camera.left = -shadowRange;
  sun.shadow.camera.right = shadowRange;
  sun.shadow.camera.top = shadowRange;
  sun.shadow.camera.bottom = -shadowRange;
  sun.shadow.bias = -0.001;
  scene.add(sun);
  scene.add(new THREE.DirectionalLight(0x8899cc, 0.4).translateX(-30).translateY(20).translateZ(-20));

  // Ground plane
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0x2a3a1a, roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.5;
  ground.receiveShadow = true;
  scene.add(ground);

  // Build blocks grouped by color+geometry for instanced rendering
  const halfW = width / 2;
  const halfL = length / 2;
  const meshes: THREE.InstancedMesh[] = [];

  interface BlockEntry {
    x: number; y: number; z: number;
    color: RGB; name: string; blockState: string;
  }
  const groups = new Map<string, BlockEntry[]>();

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const bs = grid.get(x, y, z);
        if (isAir(bs)) continue;
        if (isFullyOccluded(grid, x, y, z)) continue;

        const color = getBlockColor(bs);
        if (!color) continue;

        const name = getBlockName(bs);
        const kind = getGeometryKind(name);
        // Group by color + name + geometry kind
        const key = `${color[0]},${color[1]},${color[2]}:${name}:${kind}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push({ x, y, z, color, name, blockState: bs });
      }
    }
  }

  for (const [, entries] of groups) {
    const { color: [r, g, b], name } = entries[0];
    const kind = getGeometryKind(name);
    const geo = getGeometry(kind);

    // Try real texture, fall back to procedural
    const texture = loadBlockTexture(name, r, g, b);

    const isTransparent = name.includes('glass') || name.includes('pane')
      || name.includes('bars') || name.includes('torch')
      || name.includes('lantern') || name.includes('carpet');

    const material = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: name.includes('quartz') || name.includes('concrete') ? 0.6 : 0.88,
      metalness: name.includes('iron') || name.includes('gold') || name.includes('copper') ? 0.5 : 0.02,
      transparent: isTransparent,
      opacity: isTransparent ? 0.85 : 1.0,
      alphaTest: 0.1,
    });

    // Emissive glow for light-emitting blocks
    if (name.includes('lantern') || name.includes('glowstone') || name === 'sea_lantern'
        || name === 'redstone_lamp' || name.includes('campfire')) {
      material.emissive = new THREE.Color(r / 255, g / 255, b / 255);
      material.emissiveIntensity = 0.3;
    }

    const mesh = new THREE.InstancedMesh(geo, material, entries.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const matrix = new THREE.Matrix4();
    const rotMatrix = new THREE.Matrix4();
    const yPositions: number[] = [];
    const originals: THREE.Matrix4[] = [];

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];

      // Apply rotation for directional blocks (doors, panes)
      if (kind === 'door' || kind === 'pane') {
        const facing = getFacing(e.blockState);
        const angle = facingToAngle(facing);
        rotMatrix.makeRotationY(angle);
        matrix.identity();
        matrix.multiply(rotMatrix);
        matrix.setPosition(e.x - halfW, e.y, e.z - halfL);
      } else {
        matrix.identity();
        matrix.setPosition(e.x - halfW, e.y, e.z - halfL);
      }

      mesh.setMatrixAt(i, matrix);
      yPositions.push(e.y);
      originals.push(new THREE.Matrix4().copy(matrix));
    }

    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.yPositions = yPositions;
    mesh.userData.originalMatrices = originals;
    scene.add(mesh);
    meshes.push(mesh);
  }

  // Camera positioning
  const maxDim = Math.max(width, height, length);
  camera.position.set(maxDim * 0.9, maxDim * 0.65, maxDim * 0.9);
  camera.lookAt(0, height / 3, 0);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, height / 3, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxDistance = maxDim * 3;
  controls.update();

  // Start render loop
  animate();

  // Resize handler
  const resizeObs = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resizeObs.observe(container);

  return {
    scene,
    camera,
    renderer,
    controls,
    meshes,
    grid,
    dispose: () => {
      cancelAnimationFrame(animId);
      resizeObs.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      meshes.forEach(m => {
        const mat = m.material as THREE.MeshStandardMaterial;
        mat.map?.dispose();
        mat.dispose();
        m.dispose();
      });
    },
  };
}

/** Apply Y-cutaway: hide blocks above maxY, restore blocks at or below */
export function applyCutaway(viewer: ViewerState, maxY: number): void {
  const hideMatrix = new THREE.Matrix4();
  hideMatrix.setPosition(99999, 99999, 99999);
  for (const mesh of viewer.meshes) {
    const yArr = mesh.userData.yPositions as number[] | undefined;
    const originals = mesh.userData.originalMatrices as THREE.Matrix4[] | undefined;
    if (!yArr || !originals) continue;
    for (let i = 0; i < yArr.length; i++) {
      mesh.setMatrixAt(i, yArr[i] > maxY ? hideMatrix : originals[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}
