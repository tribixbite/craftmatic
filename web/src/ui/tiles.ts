/**
 * Tiles tab — 3D Tiles → Schematic pipeline.
 *
 * Loads Google Photorealistic 3D Tiles for a given address, voxelizes
 * the tile geometry into a BlockGrid, and displays the result in the
 * inline viewer with download options.
 *
 * Reuses the same Google Maps API key as the Map tab.
 */

import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  GoogleCloudAuthPlugin,
  TileCompressionPlugin,
  GLTFExtensionsPlugin,
  ReorientationPlugin,
  UpdateOnChangePlugin,
  UnloadTilesPlugin,
} from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { BlockGrid } from '@craft/schem/types.js';
import { threeToGrid } from '@craft/convert/voxelizer.js';
import { geocodeAddress } from '@ui/shared-geocode.js';
import { captureTileMeshes } from '@engine/tile-capture.js';
import {
  getStreetViewApiKey, hasStreetViewApiKey,
} from '@ui/import-streetview.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAP_KEY_STORAGE = 'craftmatic_map3d_api_key';
const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';
/** Max grid dimension to prevent browser freeze */
const MAX_DIMENSION = 256;

// ─── State ──────────────────────────────────────────────────────────────────

let rootEl: HTMLElement;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let tiles: TilesRenderer | null = null;
let animFrameId = 0;
let onResult: ((grid: BlockGrid, label: string) => void) | null = null;

// ─── API Key ────────────────────────────────────────────────────────────────

/** Get Google Maps API key — checks map tab storage first, then import tab */
function getApiKey(): string {
  return localStorage.getItem(MAP_KEY_STORAGE) ?? getStreetViewApiKey();
}

function hasApiKey(): boolean {
  return getApiKey().length > 0;
}

// ─── Init ───────────────────────────────────────────────────────────────────

export function initTiles(
  container: HTMLElement,
  callback: (grid: BlockGrid, label: string) => void,
): void {
  rootEl = container;
  onResult = callback;
  buildUI();

  // Lazy init: only activate when tab is visible
  const tabSection = container.closest('.tab-content') as HTMLElement | null;
  if (tabSection) {
    const observer = new MutationObserver(() => {
      const visible = tabSection.classList.contains('active');
      if (!visible) pauseRenderLoop();
      else resumeRenderLoop();
    });
    observer.observe(tabSection, { attributes: true, attributeFilter: ['class'] });
  }
}

// ─── UI ─────────────────────────────────────────────────────────────────────

function buildUI(): void {
  const key = getApiKey();
  const hasTileKey = key.length > 0;

  rootEl.innerHTML = `
    <div class="tiles-controls">
      <div class="tiles-header">
        <h3 class="tiles-title">3D Tiles → Schematic</h3>
        <p class="tiles-desc">Voxelize Google Photorealistic 3D Tiles into Minecraft blocks</p>
      </div>
      <div class="tiles-search-row">
        <input type="text" class="tiles-input" id="tiles-address"
          placeholder="Enter address..." value="">
        <button class="btn btn-primary btn-sm" id="tiles-voxelize" ${!hasTileKey ? 'disabled' : ''}>Voxelize</button>
      </div>
      <div class="tiles-params">
        <label class="tiles-param">
          <span>Resolution</span>
          <input type="range" id="tiles-resolution" min="1" max="4" step="1" value="1">
          <span id="tiles-res-label" class="tiles-param-value">1 block/m</span>
        </label>
        <label class="tiles-param">
          <span>Capture radius</span>
          <input type="range" id="tiles-radius" min="20" max="150" step="10" value="50">
          <span id="tiles-radius-label" class="tiles-param-value">50 m</span>
        </label>
      </div>
      <div class="tiles-key-hint">
        <p>${hasTileKey
          ? `API key: <code>••••${key.slice(-4)}</code>`
          : 'Google Maps API key required. Set it in the <strong>Map</strong> tab, or paste below:'}</p>
        <div class="tiles-key-row">
          <input type="password" class="tiles-key-input" id="tiles-key-input"
            placeholder="${hasTileKey ? 'Replace API key...' : 'Google Maps API key'}">
          <button class="btn btn-secondary btn-sm" id="tiles-key-save">Save</button>
          ${hasTileKey ? '<button class="btn btn-secondary btn-sm" id="tiles-key-clear">Clear</button>' : ''}
        </div>
      </div>
      <div class="tiles-status" id="tiles-status"></div>
    </div>
    <div class="tiles-viewer" id="tiles-viewer">
      <div class="tiles-placeholder">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M3 9h18M9 3v18"/>
        </svg>
        <p>Enter an address and click Voxelize</p>
        <p class="tiles-placeholder-sub">Loads 3D tiles, extracts geometry, converts to Minecraft blocks</p>
      </div>
    </div>
  `;

  // Wire events
  const addrInput = document.getElementById('tiles-address') as HTMLInputElement;
  const voxBtn = document.getElementById('tiles-voxelize') as HTMLButtonElement;
  const resSlider = document.getElementById('tiles-resolution') as HTMLInputElement;
  const resLabel = document.getElementById('tiles-res-label')!;
  const radiusSlider = document.getElementById('tiles-radius') as HTMLInputElement;
  const radiusLabel = document.getElementById('tiles-radius-label')!;

  resSlider.addEventListener('input', () => {
    resLabel.textContent = `${resSlider.value} block/m`;
  });
  radiusSlider.addEventListener('input', () => {
    radiusLabel.textContent = `${radiusSlider.value} m`;
  });

  const startVoxelize = async () => {
    const addr = addrInput.value.trim();
    if (!addr || !hasApiKey()) return;

    voxBtn.disabled = true;
    try {
      await runVoxelizePipeline(
        addr,
        parseInt(resSlider.value, 10),
        parseInt(radiusSlider.value, 10),
      );
    } finally {
      voxBtn.disabled = false;
    }
  };

  voxBtn.addEventListener('click', startVoxelize);
  addrInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startVoxelize();
  });

  // API key save + clear
  const keySave = document.getElementById('tiles-key-save');
  const keyInput = document.getElementById('tiles-key-input') as HTMLInputElement | null;
  if (keySave && keyInput) {
    keySave.addEventListener('click', () => {
      const val = keyInput.value.trim();
      if (!val) return;
      localStorage.setItem(MAP_KEY_STORAGE, val);
      keyInput.value = '';
      voxBtn.disabled = false;
      setStatus('API key saved', 'success');
      // Rebuild UI to show updated key mask + clear button
      buildUI();
    });
  }

  const keyClear = document.getElementById('tiles-key-clear');
  if (keyClear) {
    keyClear.addEventListener('click', () => {
      localStorage.removeItem(MAP_KEY_STORAGE);
      voxBtn.disabled = true;
      setStatus('API key cleared', 'info');
      // Rebuild UI to show key input prompt
      buildUI();
    });
  }
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

async function runVoxelizePipeline(
  address: string,
  resolution: number,
  radiusMeters: number,
): Promise<void> {
  const apiKey = getApiKey();

  // Step 1: Geocode
  setStatus('Geocoding address...', 'info');
  const geo = await geocodeAddress(address, apiKey);
  if (!geo) {
    setStatus('Address not found', 'error');
    return;
  }
  setStatus(`${geo.formattedAddress} — loading 3D tiles...`, 'info');

  // Step 2: Initialize TilesRenderer in a hidden container for loading only
  const viewerEl = document.getElementById('tiles-viewer')!;
  disposeViewer();

  // Create off-screen renderer for tile loading
  renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x0a0a14);
  renderer.setSize(256, 256); // Small — just for tile loading
  viewerEl.innerHTML = '';
  viewerEl.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'none'; // Hidden during load

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, 1, 1, 4000);
  // Position camera close to ground to trigger high-LOD tile loading
  camera.position.set(0, 50, 50);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 1.0));

  tiles = new TilesRenderer();
  tiles.registerPlugin(new ReorientationPlugin({
    lat: geo.lat * THREE.MathUtils.DEG2RAD,
    lon: geo.lng * THREE.MathUtils.DEG2RAD,
    height: 0,
    recenter: true,
  }));
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey }));
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }));
  tiles.registerPlugin(new TileCompressionPlugin());
  tiles.registerPlugin(new UpdateOnChangePlugin());
  tiles.registerPlugin(new UnloadTilesPlugin());

  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  scene.add(tiles.group);

  // Run a brief render loop to trigger tile loading
  const renderForLoading = () => {
    if (!tiles || !renderer || !scene || !camera) return;
    camera.updateMatrixWorld();
    tiles.update();
    renderer.render(scene, camera);
  };

  // Render a few frames to kick off tile loading
  for (let i = 0; i < 5; i++) {
    renderForLoading();
    await new Promise(r => requestAnimationFrame(r));
  }

  // Step 3: Wait for tiles to load and capture meshes
  setStatus('Waiting for tiles to load...', 'info');

  // Keep rendering while waiting for tiles
  let loading = true;
  const renderLoop = () => {
    if (!loading) return;
    renderForLoading();
    animFrameId = requestAnimationFrame(renderLoop);
  };
  renderLoop();

  try {
    const center = new THREE.Vector3(0, 0, 0);
    const capturedGroup = await captureTileMeshes(tiles, center, radiusMeters, {
      onProgress: (msg) => setStatus(msg, 'info'),
      timeout: 30000,
    });
    loading = false;
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = 0; }

    // Check if we got any meshes
    let meshCount = 0;
    capturedGroup.traverse(c => { if (c instanceof THREE.Mesh) meshCount++; });
    if (meshCount === 0) {
      setStatus('No mesh data captured — try a different address or larger radius', 'error');
      return;
    }

    // Step 4: Voxelize
    setStatus(`Voxelizing ${meshCount} meshes at ${resolution} block/m...`, 'info');

    // Yield a frame so status updates render
    await new Promise(r => requestAnimationFrame(r));

    const grid = threeToGrid(capturedGroup, resolution, {
      onProgress: (p) => {
        setStatus(`Voxelizing... ${Math.round(p.progress * 100)}% (layer ${p.currentY}/${p.totalY})`, 'info');
      },
    });

    // Enforce dimension cap
    if (grid.width > MAX_DIMENSION || grid.height > MAX_DIMENSION || grid.length > MAX_DIMENSION) {
      setStatus(`Grid too large: ${grid.width}x${grid.height}x${grid.length} (max ${MAX_DIMENSION})`, 'error');
      return;
    }

    const nonAir = grid.countNonAir();
    setStatus(
      `Done — ${grid.width}x${grid.height}x${grid.length}, ${nonAir.toLocaleString()} blocks, ${grid.palette.size} materials`,
      'success',
    );

    // Dispose the tile viewer — we don't need it anymore
    disposeViewer();

    // Step 5: Pass grid to callback (shows in inline viewer with download options)
    if (onResult) {
      onResult(grid, `tiles-${geo.formattedAddress}`);
    }

  } catch (err) {
    loading = false;
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = 0; }
    console.error('Voxelize failed:', err);
    setStatus(`Voxelize failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

// ─── Viewer Lifecycle ───────────────────────────────────────────────────────

function disposeViewer(): void {
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = 0; }
  if (tiles) { tiles.dispose(); tiles = null; }
  if (renderer) {
    renderer.dispose();
    renderer.domElement.remove();
    renderer = null;
  }
  scene = null;
  camera = null;
}

function pauseRenderLoop(): void {
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = 0; }
}

function resumeRenderLoop(): void {
  // Tiles tab doesn't maintain a persistent render loop — nothing to resume
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function setStatus(msg: string, type: 'info' | 'error' | 'success'): void {
  const el = document.getElementById('tiles-status');
  if (!el) return;
  el.textContent = msg;
  el.className = `tiles-status tiles-status-${type}`;
}
