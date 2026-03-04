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
import { exportSchem, encodeSchemBytes } from '@viewer/exporter.js';
import { createCanvasTextureSampler } from '@engine/texture-sampler.js';

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
      <div class="tiles-batch-row">
        <button class="btn btn-secondary btn-sm" id="tiles-batch" ${!hasTileKey ? 'disabled' : ''}>Batch All (14 addresses)</button>
        <span class="tiles-batch-hint">Downloads .schem for each comparison address</span>
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

  // Batch button
  const batchBtn = document.getElementById('tiles-batch') as HTMLButtonElement | null;
  if (batchBtn) {
    batchBtn.addEventListener('click', async () => {
      batchBtn.disabled = true;
      voxBtn.disabled = true;
      try {
        await batchVoxelize(
          parseInt(resSlider.value, 10),
          parseInt(radiusSlider.value, 10),
        );
      } finally {
        batchBtn.disabled = false;
        voxBtn.disabled = false;
      }
    });
  }
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

async function runVoxelizePipeline(
  address: string,
  resolution: number,
  radiusMeters: number,
  /** Skip onResult callback (used in batch mode to preserve UI) */
  skipCallback = false,
): Promise<BlockGrid | null> {
  const apiKey = getApiKey();

  // Step 1: Geocode
  setStatus('Geocoding address...', 'info');
  const geo = await geocodeAddress(address, apiKey);
  if (!geo) {
    setStatus('Address not found', 'error');
    return null;
  }
  setStatus(`${geo.formattedAddress} — loading 3D tiles...`, 'info');

  // Step 2: Initialize TilesRenderer in a hidden container for loading only
  const viewerEl = document.getElementById('tiles-viewer')!;
  disposeViewer();

  // Create off-screen renderer for tile loading
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false });
  } catch (glErr) {
    setStatus(`WebGL init failed: ${glErr instanceof Error ? glErr.message : glErr}`, 'error');
    return null;
  }
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x0a0a14);
  // Use a reasonable viewport size for SSE calculation — too small (256)
  // means the tile manager won't request detailed child tiles
  renderer.setSize(1024, 1024);
  viewerEl.innerHTML = '';
  viewerEl.appendChild(renderer.domElement);
  // Keep canvas visible — display:none causes rAF to be throttled on mobile
  renderer.domElement.style.width = '1px';
  renderer.domElement.style.height = '1px';
  renderer.domElement.style.opacity = '0.01';

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, 1, 1, 4000);
  // Camera close to ground — closer distance triggers higher-detail LOD tiles.
  // At 15m the SSE threshold was too easily satisfied; 8m forces deeper traversal
  // into the tile hierarchy to reach building-level leaf tiles with geometry.
  camera.position.set(0, 8, 8);
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
  // NOTE: Do NOT register UpdateOnChangePlugin here — it blocks tiles.update()
  // when the camera is static, preventing LOD hierarchy traversal. The Map tab
  // works because OrbitControls damping continuously moves the camera. This tab
  // uses a fixed camera, so we need every update() call to actually process tiles.
  tiles.registerPlugin(new UnloadTilesPlugin());

  // Force building-level LOD by lowering screen-space error target.
  // Default 16px stops at coarse terrain tiles; 2px demands leaf tiles
  // with actual building geometry and textures.
  tiles.errorTarget = 2.0;

  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  scene.add(tiles.group);

  // Listen for tile load errors and log them to a visible place
  tiles.addEventListener('load-error', (ev: { tile: unknown; error: unknown; url?: string }) => {
    console.warn('[tiles] load-error:', ev.url, ev.error);
  });

  setStatus('Initializing tile renderer...', 'info');

  // Render function that catches errors
  const renderForLoading = () => {
    if (!tiles || !renderer || !scene || !camera) return;
    try {
      camera.updateMatrixWorld();
      tiles.setResolutionFromRenderer(camera, renderer);
      tiles.update();
      renderer.render(scene, camera);
    } catch (renderErr) {
      console.error('[tiles] render error:', renderErr);
    }
  };

  // Render frames to let TilesRenderer traverse the LOD hierarchy.
  // Google 3D Tiles has ~10+ levels deep; each update() only schedules
  // a limited batch of tiles per frame. We need many cycles for the
  // root → regional → local → building tile chain to fully resolve.
  // Show loading progress and continue until tiles start downloading.
  let sawDownloads = false;
  for (let i = 0; i < 200; i++) {
    renderForLoading();
    const st = tiles.stats;
    const d = (st as Record<string, number>).downloading ?? 0;
    const p = (st as Record<string, number>).parsing ?? 0;
    const l = (st as Record<string, number>).loaded ?? 0;
    if (d > 0 || p > 0 || l > 0) sawDownloads = true;
    if (i % 5 === 0) {
      setStatus(`Loading 3D tiles... (${d} downloading, ${p} parsing, ${l} loaded)`, 'info');
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // Keep rendering while waiting for tiles — use setInterval to avoid
  // requestAnimationFrame throttling on mobile browsers
  let loading = true;
  const renderInterval = setInterval(() => {
    if (!loading) { clearInterval(renderInterval); return; }
    renderForLoading();
  }, 200);

  try {
    const center = new THREE.Vector3(0, 0, 0);
    // Diagnostic: mesh census in the tile scene
    let totalMeshes = 0, totalVertices = 0;
    tiles.group.traverse(c => {
      if (c instanceof THREE.Mesh) {
        totalMeshes++;
        totalVertices += ((c.geometry as THREE.BufferGeometry)?.attributes?.position?.count ?? 0);
      }
    });
    const s = tiles.stats;
    console.log('[tiles] pre-capture stats:', JSON.stringify({
      downloading: s.downloading, parsing: s.parsing, queued: s.queued,
      loaded: s.loaded, failed: s.failed, inFrustum: s.inFrustum, visible: s.visible,
    }));
    console.log(`[tiles] scene: ${totalMeshes} meshes, ${totalVertices} verts, errorTarget=${tiles.errorTarget}`);

    const capturedGroup = await captureTileMeshes(tiles, center, radiusMeters, {
      onProgress: (msg) => setStatus(msg, 'info'),
      timeout: 60000,  // 60s — Google tile hierarchy has ~10+ LOD levels
    });
    loading = false;
    clearInterval(renderInterval);

    // Log post-capture stats
    if (tiles) {
      const s2 = tiles.stats;
      console.log('[tiles] post-capture stats:', JSON.stringify({
        downloading: s2.downloading, parsing: s2.parsing, failed: s2.failed,
        loaded: s2.loaded, visible: s2.visible,
      }));
    }

    // Check if we got any meshes
    let meshCount = 0;
    capturedGroup.traverse(c => { if (c instanceof THREE.Mesh) meshCount++; });
    console.log('[tiles] captured meshCount:', meshCount);
    if (meshCount === 0) {
      setStatus('No mesh data captured — try a different address or larger radius', 'error');
      return null;
    }

    // Step 4: Voxelize
    setStatus(`Voxelizing ${meshCount} meshes at ${resolution} block/m...`, 'info');

    // Yield so status updates render
    await new Promise(r => setTimeout(r, 50));

    // Compute expected grid dimensions before voxelizing
    const preBox = new THREE.Box3().setFromObject(capturedGroup);
    const preSize = new THREE.Vector3();
    preBox.getSize(preSize);
    console.log('[tiles] mesh bounding box:', JSON.stringify({
      min: [preBox.min.x.toFixed(1), preBox.min.y.toFixed(1), preBox.min.z.toFixed(1)],
      max: [preBox.max.x.toFixed(1), preBox.max.y.toFixed(1), preBox.max.z.toFixed(1)],
      size: [preSize.x.toFixed(1), preSize.y.toFixed(1), preSize.z.toFixed(1)],
      gridWxHxL: `${Math.ceil(preSize.x * resolution)}x${Math.ceil(preSize.y * resolution)}x${Math.ceil(preSize.z * resolution)}`,
    }));

    // Create Canvas-backed texture sampler for photorealistic tile textures.
    // Without this, colors fall back to material.color (usually white).
    const sampler = createCanvasTextureSampler();
    const grid = threeToGrid(capturedGroup, resolution, {
      onProgress: (p) => {
        setStatus(`Voxelizing... ${Math.round(p.progress * 100)}% (layer ${p.currentY}/${p.totalY})`, 'info');
      },
      textureSampler: sampler,
      // Surface mode: 3D tiles are photogrammetry surfaces (not watertight solids).
      // Uses closest-point-to-geometry instead of odd-even inside/outside test.
      mode: 'surface',
    });

    // Enforce dimension cap
    if (grid.width > MAX_DIMENSION || grid.height > MAX_DIMENSION || grid.length > MAX_DIMENSION) {
      setStatus(`Grid too large: ${grid.width}x${grid.height}x${grid.length} (max ${MAX_DIMENSION})`, 'error');
      return null;
    }

    const nonAir = grid.countNonAir();
    setStatus(
      `Done — ${grid.width}x${grid.height}x${grid.length}, ${nonAir.toLocaleString()} blocks, ${grid.palette.size} materials`,
      'success',
    );

    // Dispose the tile viewer — we don't need it anymore
    disposeViewer();

    // Step 5: Pass grid to callback (shows in inline viewer with download options)
    if (onResult && !skipCallback) {
      onResult(grid, `tiles-${geo.formattedAddress}`);
    }

    return grid;

  } catch (err) {
    loading = false;
    clearInterval(renderInterval);
    console.error('[tiles] pipeline error:', err);
    const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    console.error('[tiles] stack:', msg);
    setStatus(`Voxelize failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    return null;
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
  // Render loop now uses setInterval, cleaned up via loading flag
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

// ─── Batch Processing ──────────────────────────────────────────────────────

/** Comparison addresses for batch voxelization (matches gen-comparison.ts) */
const COMPARISON_ADDRESSES = [
  { key: 'sf', address: '2340 Francisco St, San Francisco, CA 94123' },
  { key: 'newton', address: '240 Highland St, Newton, MA 02465' },
  { key: 'sanjose', address: '525 S Winchester Blvd, San Jose, CA 95128' },
  { key: 'walpole', address: '13 Union St, Walpole, NH 03608' },
  { key: 'byron', address: '2431 72nd St SW, Byron Center, MI 49315' },
  { key: 'vinalhaven', address: '216 Zekes Point Rd, Vinalhaven, ME 04863' },
  { key: 'suttonsbay', address: '5835 S Bridget Rose Ln, Suttons Bay, MI 49682' },
  { key: 'losangeles', address: '2607 Glendower Ave, Los Angeles, CA 90027' },
  { key: 'seattle', address: '4810 SW Ledroit Pl, Seattle, WA 98136' },
  { key: 'austin', address: '8504 Long Canyon Dr, Austin, TX 78730' },
  { key: 'denver', address: '433 S Xavier St, Denver, CO 80219' },
  { key: 'minneapolis', address: '2730 Ulysses St NE, Minneapolis, MN 55418' },
  { key: 'charleston', address: '41 Legare St, Charleston, SC 29401' },
  { key: 'tucson', address: '2615 E Adams St, Tucson, AZ 85716' },
];

/**
 * Batch voxelize all comparison addresses and download each as .schem.
 * Processes sequentially to avoid GPU memory pressure.
 * Call from browser console: window.batchVoxelize()
 */
async function batchVoxelize(
  resolution = 1,
  radiusMeters = 50,
  startIndex = 0,
): Promise<void> {
  if (!hasApiKey()) {
    console.error('[batch] No API key set');
    return;
  }

  const results: Array<{ key: string; ok: boolean; dims?: string }> = [];

  for (let i = startIndex; i < COMPARISON_ADDRESSES.length; i++) {
    const { key, address } = COMPARISON_ADDRESSES[i];
    console.log(`[batch] (${i + 1}/${COMPARISON_ADDRESSES.length}) ${key}: ${address}`);
    setStatus(`Batch ${i + 1}/${COMPARISON_ADDRESSES.length}: ${key}...`, 'info');

    try {
      const grid = await runVoxelizePipeline(address, resolution, radiusMeters, true);
      if (grid) {
        const filename = `tiles-${key}-res${resolution}rad${radiusMeters}.schem`;
        // Encode to .schem bytes and POST to local receiver server
        const bytes = encodeSchemBytes(grid);
        try {
          const resp = await fetch(`http://localhost:3456/save/${encodeURIComponent(filename)}`, {
            method: 'POST',
            body: bytes,
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          console.log(`[batch] ${key}: ${grid.width}x${grid.height}x${grid.length} → ${filename} (${bytes.byteLength} bytes)`);
        } catch (uploadErr) {
          // Fallback to browser download if receiver server is not running
          console.warn(`[batch] ${key}: receiver unavailable, falling back to download`, uploadErr);
          exportSchem(grid, filename);
        }
        results.push({ key, ok: true, dims: `${grid.width}x${grid.height}x${grid.length}` });
      } else {
        console.warn(`[batch] ${key}: no grid returned`);
        results.push({ key, ok: false });
      }
    } catch (err) {
      console.error(`[batch] ${key} failed:`, err);
      results.push({ key, ok: false });
    }

    // Brief pause between addresses to let GPU resources clean up
    await new Promise(r => setTimeout(r, 2000));
  }

  // Summary
  const ok = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  console.log(`[batch] Done: ${ok} succeeded, ${fail} failed`);
  console.table(results);
  setStatus(`Batch complete: ${ok}/${results.length} addresses`, ok === results.length ? 'success' : 'error');
}

// Expose batch function on window for console access
(window as Record<string, unknown>).batchVoxelize = batchVoxelize;
