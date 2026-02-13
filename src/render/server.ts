/**
 * Express dev server for the 3D schematic viewer and web app.
 * Serves the viewer HTML, static web app, and REST API for block data.
 */

import express from 'express';
import { BlockGrid } from '../schem/types.js';
import { serializeForViewerTextured } from './three-scene.js';
import chalk from 'chalk';

/** Start the 3D viewer dev server */
export function startViewerServer(
  grid: BlockGrid,
  options: { port?: number; open?: boolean } = {}
): { close: () => void } {
  const { port = 3000 } = options;

  const app = express();
  let cachedData: object | null = null;

  // Serialize block data (async, cached)
  async function getData(): Promise<object> {
    if (!cachedData) {
      cachedData = await serializeForViewerTextured(grid);
    }
    return cachedData;
  }

  // Serve the viewer HTML
  app.get('/', async (_req, res) => {
    const data = await getData();
    const html = generateViewerHTML(data);
    res.type('html').send(html);
  });

  // REST API for block data
  app.get('/api/schematic', async (_req, res) => {
    const data = await getData();
    res.json(data);
  });

  const server = app.listen(port, () => {
    console.log(`  3D viewer running at http://localhost:${port}`);
  });

  return {
    close: () => server.close(),
  };
}

/** Serve the pre-built web app (Vite SPA) with static file serving */
export function startWebAppServer(
  webDistDir: string,
  options: { port?: number; open?: boolean } = {}
): { close: () => void } {
  const { port = 3000, open: shouldOpen = true } = options;
  const app = express();

  // Serve static files from the web dist directory
  app.use(express.static(webDistDir));

  // SPA fallback — serve index.html for all non-file routes
  app.get('*', (_req, res) => {
    res.sendFile('index.html', { root: webDistDir });
  });

  const server = app.listen(port, async () => {
    const url = `http://localhost:${port}`;
    console.log(`  ${chalk.green('>')} Web app running at ${chalk.cyan(url)}`);
    console.log(chalk.dim('  Press Ctrl+C to stop'));

    if (shouldOpen) {
      try {
        const { default: openUrl } = await import('open' as string).catch(() => ({ default: null }));
        if (openUrl) {
          await openUrl(url);
        } else {
          // Fallback: use platform-specific open command
          const { exec } = await import('node:child_process');
          const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'start'
            : 'xdg-open';
          exec(`${cmd} ${url}`);
        }
      } catch {
        // Browser open is best-effort; server still runs
      }
    }
  });

  return { close: () => server.close() };
}

/**
 * Generate a self-contained HTML page with an embedded Three.js viewer.
 * Supports both textured palette format and legacy flat color format.
 */
export function generateViewerHTML(viewerData: object): string {
  const dataJson = JSON.stringify(viewerData);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Craftmatic 3D Viewer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a14; overflow: hidden; font-family: system-ui, sans-serif; }
    canvas { display: block; }
    #info {
      position: fixed; top: 12px; left: 12px;
      color: #ddd; font-size: 13px;
      background: rgba(0,0,0,0.75); padding: 8px 14px;
      border-radius: 6px; pointer-events: none;
      backdrop-filter: blur(4px);
    }
    #controls {
      position: fixed; bottom: 12px; left: 12px;
      color: #999; font-size: 12px;
      background: rgba(0,0,0,0.75); padding: 6px 12px;
      border-radius: 6px; pointer-events: none;
      backdrop-filter: blur(4px);
    }
    #cutaway {
      position: fixed; right: 16px; top: 50%;
      transform: translateY(-50%);
      writing-mode: bt-lr;
      -webkit-appearance: slider-vertical;
      width: 24px; height: 200px;
    }
    #cutaway-label {
      position: fixed; right: 16px; top: calc(50% + 110px);
      color: #888; font-size: 11px; text-align: center;
      width: 24px; pointer-events: none;
    }
  </style>
</head>
<body>
  <div id="info">Loading...</div>
  <div id="controls">Drag: rotate | Scroll: zoom | Right-drag: pan | Slider: cutaway</div>
  <input type="range" id="cutaway" min="0" step="1" value="999" orient="vertical">
  <div id="cutaway-label">Y</div>
  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.172.0/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.172.0/examples/jsm/"
    }
  }
  </script>
  <script type="module">
    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

    const data = ${dataJson};
    const hasPalette = !!data.palette;

    // ─── Scene ──────────────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);
    scene.fog = new THREE.FogExp2(0x1a1a2e, 0.006);

    const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(innerWidth, innerHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    document.body.appendChild(renderer.domElement);

    // ─── Lighting ───────────────────────────────────────────────────────
    const ambient = new THREE.AmbientLight(0x606080, 0.5);
    scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0x87ceeb, 0x443322, 0.6);
    scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff0dd, 1.8);
    sun.position.set(40, 60, 25);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 200;
    const shadowRange = Math.max(data.width, data.length) * 0.8;
    sun.shadow.camera.left = -shadowRange;
    sun.shadow.camera.right = shadowRange;
    sun.shadow.camera.top = shadowRange;
    sun.shadow.camera.bottom = -shadowRange;
    sun.shadow.bias = -0.001;
    scene.add(sun);

    // Fill light from opposite side
    const fill = new THREE.DirectionalLight(0x8899cc, 0.4);
    fill.position.set(-30, 20, -20);
    scene.add(fill);

    // ─── Ground plane ──────────────────────────────────────────────────
    const groundGeo = new THREE.PlaneGeometry(200, 200);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x2a3a1a, roughness: 1, metalness: 0,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.5;
    ground.receiveShadow = true;
    scene.add(ground);

    // ─── Texture helpers ────────────────────────────────────────────────
    const textureCache = new Map();
    const loadingTextures = [];

    // Load a base64 PNG into a THREE.Texture
    function loadBase64Texture(dataUri) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const tex = new THREE.Texture(img);
          tex.magFilter = THREE.NearestFilter;
          tex.minFilter = THREE.NearestFilter;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.needsUpdate = true;
          resolve(tex);
        };
        img.onerror = () => resolve(null);
        img.src = dataUri;
      });
    }

    // Improved procedural texture — matches block type patterns
    function makeProceduralTexture(r, g, b, blockName) {
      const size = 16;
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      ctx.fillStyle = \`rgb(\${r},\${g},\${b})\`;
      ctx.fillRect(0, 0, size, size);
      const imgData = ctx.getImageData(0, 0, size, size);
      const d = imgData.data;

      // Seeded RNG
      let seed = (r * 7919 + g * 6271 + b * 4447) | 0;
      const rand = () => { seed = (seed * 16807 + 1) % 2147483647; return seed / 2147483647; };

      const name = blockName || '';

      if (name.includes('planks') || name.includes('door') || name.includes('trapdoor')) {
        // Wood grain pattern: horizontal lines with slight variation
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
        // Plank dividers every 4 pixels
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
        // Bark pattern: vertical streaks
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
        // Stone speckle: random pixel variation
        for (let i = 0; i < d.length; i += 4) {
          const n = (rand() - 0.5) * 28;
          d[i] = Math.max(0, Math.min(255, d[i] + n));
          d[i+1] = Math.max(0, Math.min(255, d[i+1] + n));
          d[i+2] = Math.max(0, Math.min(255, d[i+2] + n * 0.8));
        }
        // Stone crack lines
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
        // Brick pattern: alternating offset rows
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
        // Glass: mostly transparent-looking with edge highlight
        for (let i = 0; i < d.length; i += 4) {
          d[i+3] = 180; // Semi-transparent
        }
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
        // Fabric/smooth: very subtle noise
        for (let i = 0; i < d.length; i += 4) {
          const n = (rand() - 0.5) * 8;
          d[i] = Math.max(0, Math.min(255, d[i] + n));
          d[i+1] = Math.max(0, Math.min(255, d[i+1] + n));
          d[i+2] = Math.max(0, Math.min(255, d[i+2] + n));
        }
      } else if (name.includes('quartz') || name.includes('smooth')) {
        // Smooth stone: subtle directional grain
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
        // Default: moderate noise + edge darkening
        for (let i = 0; i < d.length; i += 4) {
          const n = (rand() - 0.5) * 14;
          d[i] = Math.max(0, Math.min(255, d[i] + n));
          d[i+1] = Math.max(0, Math.min(255, d[i+1] + n));
          d[i+2] = Math.max(0, Math.min(255, d[i+2] + n));
        }
      }

      // Edge darkening (block border) for all non-glass blocks
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

    // ─── Geometry helpers ──────────────────────────────────────────────

    function getGeoKind(name) {
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

    const geoCache = {};
    function getGeo(kind) {
      if (geoCache[kind]) return geoCache[kind];
      let g;
      switch (kind) {
        case 'slab':    g = new THREE.BoxGeometry(1, 0.5, 1); break;
        case 'carpet':  g = new THREE.BoxGeometry(1, 0.0625, 1); break;
        case 'fence':   g = new THREE.BoxGeometry(0.25, 1, 0.25); break;
        case 'torch':   g = new THREE.BoxGeometry(0.15, 0.6, 0.15); break;
        case 'lantern': g = new THREE.BoxGeometry(0.35, 0.4, 0.35); break;
        case 'chain':   g = new THREE.BoxGeometry(0.1, 1, 0.1); break;
        case 'door':    g = new THREE.BoxGeometry(1, 1, 0.2); break;
        case 'pane':    g = new THREE.BoxGeometry(0.1, 1, 1); break;
        case 'rod':     g = new THREE.BoxGeometry(0.12, 1, 0.12); break;
        default:        g = new THREE.BoxGeometry(1, 1, 1);
      }
      geoCache[kind] = g;
      return g;
    }

    function getFacingAngle(fullName) {
      const m = fullName.match(/facing=(\\w+)/);
      if (!m) return 0;
      switch (m[1]) {
        case 'south': return 0;
        case 'west':  return Math.PI / 2;
        case 'north': return Math.PI;
        case 'east':  return -Math.PI / 2;
        default: return 0;
      }
    }

    // ─── Build meshes ──────────────────────────────────────────────────

    const halfW = data.width / 2;
    const halfL = data.length / 2;
    let allMeshes = []; // for cutaway filtering

    async function buildScene() {
      if (hasPalette) {
        // Group blocks by palette index + geometry kind
        const groups = new Map();
        for (const block of data.blocks) {
          const entry = data.palette[block.p];
          const blockName = (entry.name || '').replace('minecraft:', '').replace(/\\[.*\\]/, '');
          const kind = getGeoKind(blockName);
          const key = block.p + ':' + kind;
          if (!groups.has(key)) groups.set(key, { pIdx: block.p, kind, blocks: [] });
          groups.get(key).blocks.push(block);
        }

        for (const [, group] of groups) {
          const entry = data.palette[group.pIdx];
          const [r, g, b] = entry.color;
          const fullName = entry.name || '';
          const blockName = fullName.replace('minecraft:', '').replace(/\\[.*\\]/, '');
          const kind = group.kind;

          let texture;
          if (entry.texture) {
            texture = await loadBase64Texture(entry.texture);
          }
          if (!texture) {
            texture = makeProceduralTexture(r, g, b, blockName);
          }

          const isTransparent = blockName.includes('glass') || blockName.includes('pane')
            || blockName.includes('bars') || blockName.includes('torch')
            || blockName.includes('lantern') || blockName.includes('carpet');

          const material = new THREE.MeshStandardMaterial({
            map: texture,
            roughness: blockName.includes('quartz') || blockName.includes('concrete') ? 0.6 : 0.88,
            metalness: blockName.includes('iron') || blockName.includes('gold') ? 0.5 : 0.02,
            transparent: isTransparent,
            opacity: isTransparent ? 0.85 : 1.0,
            alphaTest: 0.1,
          });

          // Emissive glow for light-emitting blocks
          if (blockName.includes('lantern') || blockName.includes('glowstone')
              || blockName === 'sea_lantern' || blockName === 'redstone_lamp'
              || blockName.includes('campfire')) {
            material.emissive = new THREE.Color(r / 255, g / 255, b / 255);
            material.emissiveIntensity = 0.3;
          }

          const geo = getGeo(kind);
          const positions = group.blocks;
          const mesh = new THREE.InstancedMesh(geo, material, positions.length);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          const matrix = new THREE.Matrix4();
          const rotMatrix = new THREE.Matrix4();
          const yPositions = [];
          const originalMatrices = [];
          for (let i = 0; i < positions.length; i++) {
            const p = positions[i];
            // Apply rotation for directional blocks
            if (kind === 'door' || kind === 'pane') {
              const angle = getFacingAngle(fullName);
              rotMatrix.makeRotationY(angle);
              matrix.identity();
              matrix.multiply(rotMatrix);
              matrix.setPosition(p.x - halfW, p.y, p.z - halfL);
            } else {
              matrix.identity();
              matrix.setPosition(p.x - halfW, p.y, p.z - halfL);
            }
            mesh.setMatrixAt(i, matrix);
            yPositions.push(p.y);
            originalMatrices.push(new THREE.Matrix4().copy(matrix));
          }
          mesh.instanceMatrix.needsUpdate = true;
          mesh.userData.yPositions = yPositions;
          mesh.userData.originalMatrices = originalMatrices;
          scene.add(mesh);
          allMeshes.push(mesh);
        }
      } else {
        // Legacy flat color format
        const colorGroups = new Map();
        for (const block of data.blocks) {
          const key = block.color.join(',');
          if (!colorGroups.has(key)) colorGroups.set(key, { color: block.color, positions: [] });
          colorGroups.get(key).positions.push(block);
        }

        for (const [, group] of colorGroups) {
          const [r, g, b] = group.color;
          const texture = makeProceduralTexture(r, g, b, '');
          const material = new THREE.MeshStandardMaterial({
            map: texture, roughness: 0.85, metalness: 0.05,
          });
          const mesh = new THREE.InstancedMesh(geometry, material, group.positions.length);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          const matrix = new THREE.Matrix4();
          for (let i = 0; i < group.positions.length; i++) {
            const p = group.positions[i];
            matrix.setPosition(p.x - halfW, p.y, p.z - halfL);
            mesh.setMatrixAt(i, matrix);
          }
          mesh.instanceMatrix.needsUpdate = true;
          scene.add(mesh);
        }
      }
    }

    // ─── Camera & Controls ──────────────────────────────────────────────

    const maxDim = Math.max(data.width, data.height, data.length);
    camera.position.set(maxDim * 0.9, maxDim * 0.65, maxDim * 0.9);
    camera.lookAt(0, data.height / 3, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, data.height / 3, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxDistance = maxDim * 3;
    controls.update();

    // ─── Cutaway slider ─────────────────────────────────────────────────

    const slider = document.getElementById('cutaway');
    const sliderLabel = document.getElementById('cutaway-label');
    slider.max = data.height;
    slider.value = data.height;

    slider.addEventListener('input', () => {
      const maxY = parseInt(slider.value);
      sliderLabel.textContent = maxY >= data.height ? 'All' : 'Y:' + maxY;
      applyCutaway(maxY);
    });

    function applyCutaway(maxY) {
      const hideMatrix = new THREE.Matrix4();
      hideMatrix.setPosition(99999, 99999, 99999);
      for (const mesh of allMeshes) {
        if (!mesh.userData.yPositions) continue;
        const yArr = mesh.userData.yPositions;
        const originals = mesh.userData.originalMatrices;
        for (let i = 0; i < yArr.length; i++) {
          mesh.setMatrixAt(i, yArr[i] > maxY ? hideMatrix : originals[i]);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
    }

    // ─── Info HUD ──────────────────────────────────────────────────────

    document.getElementById('info').innerHTML =
      '<b>Craftmatic</b> — ' +
      data.width + 'x' + data.height + 'x' + data.length +
      ' — ' + data.blockCount.toLocaleString() + ' blocks' +
      (data.palette ? ' — ' + data.palette.length + ' materials' : '');

    // ─── Resize ─────────────────────────────────────────────────────────

    addEventListener('resize', () => {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    });

    // ─── Render loop ────────────────────────────────────────────────────

    function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }

    await buildScene();
    animate();
  </script>
</body>
</html>`;
}
