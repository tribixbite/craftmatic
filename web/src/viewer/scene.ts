/**
 * Three.js 3D viewer for BlockGrid schematics.
 * Creates an interactive scene with textured blocks, lighting, and controls.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BlockGrid } from '@craft/schem/types.js';
import { getBlockColor } from '@craft/blocks/colors.js';
import { isAir, isSolidBlock, getBlockName } from '@craft/blocks/registry.js';
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

/** Seeded RNG for procedural textures */
function createRng(r: number, g: number, b: number): () => number {
  let seed = (r * 7919 + g * 6271 + b * 4447) | 0;
  return () => { seed = (seed * 16807 + 1) % 2147483647; return seed / 2147483647; };
}

/** Generate a procedural block texture on a Canvas */
function makeProceduralTexture(r: number, g: number, b: number, blockName: string): THREE.CanvasTexture {
  const size = 16;
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
        const grain = Math.sin(y * 1.2 + rand() * 0.3) * 8 + lineVar * 0.3;
        d[idx] = Math.max(0, Math.min(255, d[idx] + grain + (rand() - 0.5) * 6));
        d[idx+1] = Math.max(0, Math.min(255, d[idx+1] + grain + (rand() - 0.5) * 6));
        d[idx+2] = Math.max(0, Math.min(255, d[idx+2] + grain * 0.5 + (rand() - 0.5) * 4));
      }
    }
    for (let x = 0; x < size; x++) {
      if (x % 4 === 0) {
        for (let y = 0; y < size; y++) {
          const idx = (y * size + x) * 4;
          d[idx] = Math.max(0, d[idx] - 18);
          d[idx+1] = Math.max(0, d[idx+1] - 18);
          d[idx+2] = Math.max(0, d[idx+2] - 12);
        }
      }
    }
  } else if (name.includes('log') || name.includes('wood')) {
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
              || name.includes('blackstone')) {
    for (let i = 0; i < d.length; i += 4) {
      const n = (rand() - 0.5) * 28;
      d[i] = Math.max(0, Math.min(255, d[i] + n));
      d[i+1] = Math.max(0, Math.min(255, d[i+1] + n));
      d[i+2] = Math.max(0, Math.min(255, d[i+2] + n * 0.8));
    }
    for (let i = 0; i < 3; i++) {
      const sx = Math.floor(rand() * size);
      const sy = Math.floor(rand() * size);
      const len = 3 + Math.floor(rand() * 6);
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
      const row = Math.floor(y / 4);
      const offset = (row % 2) * 4;
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const isMortar = (y % 4 === 0) || ((x + offset) % 8 === 0 && y % 4 !== 0);
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
        if (x === 0 || y === 0) {
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
        const n = (rand() - 0.5) * 6 + Math.sin(y * 0.5) * 3;
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
        if (x === 0 || y === 0 || x === size-1 || y === size-1) {
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

/** Build a Three.js scene from a BlockGrid and mount it on a container element */
export function createViewer(container: HTMLElement, grid: BlockGrid): ViewerState {
  const { width, height, length } = grid;

  // Scene setup
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);
  scene.fog = new THREE.FogExp2(0x1a1a2e, 0.006);

  const camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  container.appendChild(renderer.domElement);

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

  // Build blocks grouped by color for instanced rendering
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const halfW = width / 2;
  const halfL = length / 2;
  const meshes: THREE.InstancedMesh[] = [];

  interface BlockEntry { x: number; y: number; z: number; color: RGB; name: string }
  const colorGroups = new Map<string, BlockEntry[]>();

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const bs = grid.get(x, y, z);
        if (isAir(bs)) continue;
        if (isFullyOccluded(grid, x, y, z)) continue;

        const color = getBlockColor(bs);
        if (!color) continue;

        const name = getBlockName(bs);
        const key = `${color[0]},${color[1]},${color[2]}:${name}`;
        if (!colorGroups.has(key)) colorGroups.set(key, []);
        colorGroups.get(key)!.push({ x, y, z, color, name });
      }
    }
  }

  for (const [, entries] of colorGroups) {
    const { color: [r, g, b], name } = entries[0];
    const texture = makeProceduralTexture(r, g, b, name);

    const isTransparent = name.includes('glass') || name.includes('pane')
      || name.includes('bars') || name.includes('torch')
      || name.includes('lantern') || name.includes('carpet');

    const material = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: name.includes('quartz') || name.includes('concrete') ? 0.6 : 0.88,
      metalness: name.includes('iron') || name.includes('gold') ? 0.5 : 0.02,
      transparent: isTransparent,
      opacity: isTransparent ? 0.85 : 1.0,
      alphaTest: 0.1,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, entries.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const matrix = new THREE.Matrix4();
    const yPositions: number[] = [];
    const originals: THREE.Matrix4[] = [];

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      matrix.setPosition(e.x - halfW, e.y, e.z - halfL);
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

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, height / 3, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxDistance = maxDim * 3;
  controls.update();

  // Render loop
  let animId = 0;
  function animate() {
    animId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
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
      geometry.dispose();
      meshes.forEach(m => {
        (m.material as THREE.Material).dispose();
        m.geometry.dispose();
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
