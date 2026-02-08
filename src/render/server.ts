/**
 * Express dev server for the 3D schematic viewer.
 * Serves the viewer HTML and provides REST API for block data.
 */

import express from 'express';
import { BlockGrid } from '../schem/types.js';
import { serializeForViewer } from './three-scene.js';

/** Start the 3D viewer dev server */
export function startViewerServer(
  grid: BlockGrid,
  options: { port?: number; open?: boolean } = {}
): { close: () => void } {
  const { port = 3000 } = options;

  const app = express();

  // Serialize block data for the viewer
  const viewerData = serializeForViewer(grid);

  // Serve the viewer HTML
  app.get('/', (_req, res) => {
    const html = generateViewerHTML(viewerData);
    res.type('html').send(html);
  });

  // REST API for block data
  app.get('/api/schematic', (_req, res) => {
    res.json(viewerData);
  });

  const server = app.listen(port, () => {
    console.log(`  3D viewer running at http://localhost:${port}`);
  });

  return {
    close: () => server.close(),
  };
}

/**
 * Generate a self-contained HTML page with an embedded Three.js viewer.
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
    body { background: #111; overflow: hidden; font-family: system-ui, sans-serif; }
    canvas { display: block; }
    #info {
      position: fixed; top: 12px; left: 12px;
      color: #ccc; font-size: 13px;
      background: rgba(0,0,0,0.7); padding: 8px 14px;
      border-radius: 6px; pointer-events: none;
    }
    #controls {
      position: fixed; bottom: 12px; left: 12px;
      color: #999; font-size: 12px;
      background: rgba(0,0,0,0.7); padding: 6px 12px;
      border-radius: 6px; pointer-events: none;
    }
  </style>
</head>
<body>
  <div id="info">Loading...</div>
  <div id="controls">Drag to rotate | Scroll to zoom | Right-drag to pan</div>
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

    // Scene setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);
    scene.fog = new THREE.Fog(0x1a1a2e, 100, 300);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    document.body.appendChild(renderer.domElement);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0x404050, 0.6);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(50, 80, 30);
    dirLight.castShadow = false;
    scene.add(dirLight);
    const hemiLight = new THREE.HemisphereLight(0x8090c0, 0x302010, 0.4);
    scene.add(hemiLight);

    // Procedural texture generator — creates 16x16 canvas textures
    function makeBlockTexture(r, g, b) {
      const size = 16;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      // Base fill
      ctx.fillStyle = \`rgb(\${r},\${g},\${b})\`;
      ctx.fillRect(0, 0, size, size);
      // Noise overlay for depth
      const imgData = ctx.getImageData(0, 0, size, size);
      const d = imgData.data;
      let seed = r * 1000 + g * 100 + b;
      for (let i = 0; i < d.length; i += 4) {
        seed = (seed * 16807 + 0) % 2147483647;
        const noise = ((seed / 2147483647) - 0.5) * 18;
        d[i]     = Math.max(0, Math.min(255, d[i] + noise));
        d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + noise));
        d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + noise));
      }
      // Subtle border/edge darkening
      for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
          if (x === 0 || y === 0 || x === size - 1 || y === size - 1) {
            const idx = (y * size + x) * 4;
            d[idx]     = Math.max(0, d[idx] - 20);
            d[idx + 1] = Math.max(0, d[idx + 1] - 20);
            d[idx + 2] = Math.max(0, d[idx + 2] - 20);
          }
        }
      }
      ctx.putImageData(imgData, 0, 0);
      const tex = new THREE.CanvasTexture(canvas);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      return tex;
    }

    // Build block meshes grouped by color
    const colorGroups = new Map();
    for (const block of data.blocks) {
      const key = block.color.join(',');
      if (!colorGroups.has(key)) colorGroups.set(key, { color: block.color, positions: [] });
      colorGroups.get(key).positions.push(block);
    }

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const halfW = data.width / 2;
    const halfL = data.length / 2;

    for (const [key, group] of colorGroups) {
      const [r, g, b] = group.color;
      const texture = makeBlockTexture(r, g, b);
      const material = new THREE.MeshStandardMaterial({
        map: texture,
        roughness: 0.85,
        metalness: 0.05,
      });
      const mesh = new THREE.InstancedMesh(geometry, material, group.positions.length);
      const matrix = new THREE.Matrix4();
      for (let i = 0; i < group.positions.length; i++) {
        const p = group.positions[i];
        matrix.setPosition(p.x - halfW, p.y, p.z - halfL);
        mesh.setMatrixAt(i, matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
    }

    // Camera position
    const maxDim = Math.max(data.width, data.height, data.length);
    camera.position.set(maxDim * 0.8, maxDim * 0.6, maxDim * 0.8);
    camera.lookAt(0, data.height / 3, 0);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, data.height / 3, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.update();

    // Info
    document.getElementById('info').textContent =
      \`Craftmatic — \${data.width}x\${data.height}x\${data.length} — \${data.blockCount.toLocaleString()} blocks\`;

    // Resize
    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // Render loop
    function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();
  </script>
</body>
</html>`;
}
