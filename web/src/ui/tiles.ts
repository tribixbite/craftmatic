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
import { threeToGridAsync } from '@craft/convert/voxelizer.js';
import { geocodeAddress } from '@ui/shared-geocode.js';
import { captureTileMeshes } from '@engine/tile-capture.js';
import {
  getStreetViewApiKey, hasStreetViewApiKey,
} from '@ui/import-streetview.js';
import { exportSchem, encodeSchemBytes } from '@viewer/exporter.js';
import { createCanvasTextureSampler } from '@engine/texture-sampler.js';
import {
  trimSparseBottomLayers, analyzeGrid, cropToAABB,
  constrainPalette, modeFilter3D,
  fillInteriorGaps, clearOpenAirFill, removeSmallComponents,
  removeGroundPlane, stripVegetation,
  morphClose3D, smoothSurface, flattenFacades, glazeDarkWindows, injectSyntheticWindows,
  extractEnvironmentPositions, replaceWithCleanFeatures, detectAndRegularizeWindows,
} from '@craft/convert/mesh-filter.js';
import type { AnalysisResult, ExtractedEnvironment } from '@craft/convert/mesh-filter.js';
import { resolveBuildingBounds, type BuildingBounds } from '@ui/building-bounds.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAP_KEY_STORAGE = 'craftmatic_map3d_api_key';
const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';
/** Max grid dimension to prevent browser freeze */
const MAX_DIMENSION = 256;

// ─── State ──────────────────────────────────────────────────────────────────

let rootEl: HTMLElement;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.OrthographicCamera | null = null;
let tiles: TilesRenderer | null = null;
let animFrameId = 0;
/** Metadata about the tiles pipeline run, passed to the result callback */
export interface TilesResultMeta {
  lat: number;
  lng: number;
  resolution: number;
  captureRadius: number;
  /** Resolved building bounds — used for satellite overlay zoom + positioning */
  buildingBounds: BuildingBounds | null;
}

let onResult: ((grid: BlockGrid, label: string, analysis: AnalysisResult | null, meta: TilesResultMeta | null) => void) | null = null;

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
  callback: (grid: BlockGrid, label: string, analysis: AnalysisResult | null, meta: TilesResultMeta | null) => void,
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
          <input type="range" id="tiles-resolution" min="1" max="4" step="1" value="3">
          <span id="tiles-res-label" class="tiles-param-value">3 block/m (1 ft/block)</span>
        </label>
        <label class="tiles-param">
          <span>Capture radius</span>
          <input type="range" id="tiles-radius" min="20" max="150" step="10" value="30">
          <span id="tiles-radius-label" class="tiles-param-value">30 m</span>
        </label>
        <label class="tiles-param tiles-scene-toggle">
          <span>Scene Mode</span>
          <input type="checkbox" id="tiles-scene-mode">
          <span class="tiles-param-value" id="tiles-scene-label">Off — building only</span>
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

  const sceneToggle = document.getElementById('tiles-scene-mode') as HTMLInputElement;
  const sceneLabel = document.getElementById('tiles-scene-label')!;

  resSlider.addEventListener('input', () => {
    const v = parseInt(resSlider.value, 10);
    resLabel.textContent = v === 3 ? '3 block/m (1 ft/block)' : `${v} block/m`;
  });
  radiusSlider.addEventListener('input', () => {
    radiusLabel.textContent = `${radiusSlider.value} m`;
  });
  sceneToggle.addEventListener('change', () => {
    sceneLabel.textContent = sceneToggle.checked ? 'On — building + environment' : 'Off — building only';
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
  setStatus(`${geo.formattedAddress} — resolving building bounds...`, 'info');
  // Yield so status renders before potentially slow WebGL init
  await new Promise(r => setTimeout(r, 50));

  // Step 1b: Resolve building bounds in parallel with WebGL setup.
  // This queries Solar API + OSM to determine the building's physical size,
  // optimal capture radius, and satellite zoom level.
  const boundsPromise = resolveBuildingBounds(
    geo.lat, geo.lng, apiKey, geo.bounds,
  ).catch(err => {
    console.warn('[tiles] building bounds resolution failed (non-fatal):', err);
    return null as BuildingBounds | null;
  });

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
  // Validate WebGL context was actually created (Android may silently fail
  // when too many contexts exist from other tabs)
  const gl = renderer.getContext();
  if (!gl || gl.isContextLost()) {
    setStatus('WebGL context lost — close other tabs and retry', 'error');
    renderer.dispose();
    renderer = null;
    return null;
  }
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x0a0a14);
  // Viewport for SSE calculation — 512 balances LOD detail vs GPU memory on mobile
  renderer.setSize(512, 512);
  viewerEl.innerHTML = '';
  viewerEl.appendChild(renderer.domElement);
  // Keep canvas visible — display:none causes rAF to be throttled on mobile
  renderer.domElement.style.width = '1px';
  renderer.domElement.style.height = '1px';
  renderer.domElement.style.opacity = '0.01';

  scene = new THREE.Scene();
  // OrthographicCamera from above — frustum covers full capture volume at all heights.
  // PerspectiveCamera at (0,8,8) caused TilesRenderer to never request tiles above ~50m,
  // truncating skyscrapers (ESB, Chrysler, Flatiron). Ortho from Y=500 creates a
  // frustum column that loads tiles for any building height.
  const halfExtent = radiusMeters * 1.2; // 20% margin for LOD overlap
  camera = new THREE.OrthographicCamera(
    -halfExtent, halfExtent, halfExtent, -halfExtent, 1, 2000,
  );
  camera.position.set(0, 500, 0);
  camera.lookAt(0, 0, 0);
  scene.add(new THREE.AmbientLight(0xffffff, 1.0));

  setStatus(`${geo.formattedAddress} — setting up tile renderer...`, 'info');
  await new Promise(r => setTimeout(r, 50));

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

  // Force building-level LOD, but scale with radius to prevent mobile GPU OOM.
  // Small radius (30m) → errorTarget 4.0 (high detail, residential buildings)
  // Large radius (150m) → errorTarget 20.0 (lower detail, prevents crash)
  // Default 16px stops at coarse terrain tiles; lower values demand leaf tiles
  // with actual building geometry and textures.
  tiles.errorTarget = Math.max(4.0, (radiusMeters / 30) * 4.0);

  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  scene.add(tiles.group);

  // Listen for tile load errors and log them to a visible place
  tiles.addEventListener('load-error', (ev: { tile: unknown; error: unknown; url?: string }) => {
    console.warn('[tiles] load-error:', ev.url, ev.error);
  });

  // Await building bounds (was resolving in parallel with WebGL + TilesRenderer setup)
  const bounds = await boundsPromise;
  if (bounds && bounds.confidence > 0.5) {
    // Auto-set capture radius from building dimensions
    radiusMeters = bounds.captureRadiusM;
    console.log(`[tiles] auto-radius: ${radiusMeters}m (building ~${bounds.widthM}×${bounds.lengthM}m, sources: ${bounds.sources.join(',')})`);
    setStatus(
      `${geo.formattedAddress} — building ~${bounds.widthM}×${bounds.lengthM}m, capture radius ${radiusMeters}m`,
      'info',
    );
    // Update UI slider to reflect computed value
    const radiusSlider = document.getElementById('tiles-radius') as HTMLInputElement | null;
    const radiusLabel = document.getElementById('tiles-radius-label');
    if (radiusSlider) {
      radiusSlider.value = String(Math.min(150, Math.max(20, radiusMeters)));
      if (radiusLabel) radiusLabel.textContent = `${radiusMeters} m (auto)`;
    }
  } else if (bounds) {
    console.log(`[tiles] bounds low confidence (${bounds.confidence}), using user radius ${radiusMeters}m`);
  }

  setStatus('Loading 3D tiles...', 'info');
  await new Promise(r => setTimeout(r, 50));

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
    const q = (st as Record<string, number>).queued ?? 0;
    const f = (st as Record<string, number>).failed ?? 0;
    if (d > 0 || p > 0 || l > 0) sawDownloads = true;
    if (i % 10 === 0) {
      setStatus(`Loading 3D tiles... (${d} downloading, ${p} parsing, ${l} loaded${f > 0 ? `, ${f} failed` : ''})`, 'info');
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
    setStatus('Capturing tile meshes...', 'info');
    await new Promise(r => setTimeout(r, 50));

    // Diagnostic: mesh census in the tile scene
    let totalMeshes = 0, totalVertices = 0;
    tiles.group.traverse(c => {
      if (c instanceof THREE.Mesh) {
        totalMeshes++;
        totalVertices += ((c.geometry as THREE.BufferGeometry)?.attributes?.position?.count ?? 0);
      }
    });
    const s = tiles.stats;
    console.log(`[tiles] pre-capture: ${totalMeshes} meshes, ${totalVertices} verts, loaded=${s.loaded}, failed=${(s as Record<string, number>).failed ?? 0}`);

    const captureResult = await captureTileMeshes(tiles, center, radiusMeters, {
      onProgress: (msg) => setStatus(msg, 'info'),
      timeout: 60000,  // 60s — Google tile hierarchy has ~10+ LOD levels
      extractHeightmap: true,  // Extract terrain for procedural environment draping
      heightmapResolution: resolution,
    });
    const capturedGroup = captureResult.buildingGroup;
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
    if (captureResult.terrainHeightmap) {
      console.log(`[tiles] terrain heightmap: ${captureResult.heightmapWidth}x${captureResult.heightmapLength}`);
    }

    // Check if we got any meshes
    const { captured: meshCount } = captureResult.stats;
    console.log('[tiles] captured meshCount:', meshCount);
    if (meshCount === 0) {
      setStatus('No mesh data captured — try a different address or larger radius', 'error');
      return null;
    }

    // Export captured meshes as GLB for offline CLI re-voxelization.
    // Non-blocking — fire and forget so it doesn't delay the voxelization.
    exportCapturedGLB(capturedGroup, address).catch(err => {
      console.warn('[tiles] GLB export failed (non-fatal):', err);
    });

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
    const grid = await threeToGridAsync(capturedGroup, resolution, {
      onProgress: (p) => {
        const msg = p.message
          ? p.message
          : `Voxelizing... ${Math.round(p.progress * 100)}% (layer ${p.currentY}/${p.totalY})`;
        setStatus(msg, 'info');
      },
      textureSampler: sampler,
      // Surface mode: 3D tiles are photogrammetry surfaces (not watertight solids).
      // Uses closest-point-to-geometry instead of odd-even inside/outside test.
      mode: 'surface',
      // Yield to main thread every 4 layers to keep UI responsive on mobile
      yieldInterval: 4,
      // Don't filter vegetation during voxelization — trees act as solid walls during
      // fillInteriorGaps, preventing holes behind canopy. Strip in post-processing.
      filterVegetation: false,
    });

    // Post-voxel Y trim: remove sparse bottom layers (residual terrain that
    // passed the height filter). Scan bottom-up for the first layer with >5%
    // fill rate — everything below is likely ground/road fragments.
    const trimmedGrid = trimSparseBottomLayers(grid);
    if (trimmedGrid !== grid) {
      const trimmed = grid.height - trimmedGrid.height;
      console.log(`[tiles] trimmed ${trimmed} sparse bottom layers (${grid.height}→${trimmedGrid.height})`);
    }

    // Enforce dimension cap
    if (trimmedGrid.width > MAX_DIMENSION || trimmedGrid.height > MAX_DIMENSION || trimmedGrid.length > MAX_DIMENSION) {
      setStatus(`Grid too large: ${trimmedGrid.width}x${trimmedGrid.height}x${trimmedGrid.length} (max ${MAX_DIMENSION})`, 'error');
      return null;
    }

    // Run auto-analysis to drive post-processing decisions
    let analysis: AnalysisResult | null = null;
    try {
      analysis = analyzeGrid(trimmedGrid);
      console.log(`[tiles] analysis: confidence=${analysis.confidence.toFixed(1)}, quality=${analysis.dataQuality}, typology=${analysis.typology}`);
    } catch (err) {
      console.warn('[tiles] analysis failed (non-fatal):', err);
    }

    // ── Post-processing: same essential pipeline as CLI voxelizer ──
    // Without these steps the raw voxelization is noisy photogrammetry chaos.
    const sceneEl = document.getElementById('tiles-scene-mode') as HTMLInputElement | null;
    const isSceneMode = !!(sceneEl?.checked && geo);
    setStatus('Post-processing...', 'info');
    await new Promise(r => setTimeout(r, 50));
    const envPositions = await postProcessTilesGrid(trimmedGrid, analysis, isSceneMode, resolution);

    // ── Scene-specific steps (window/door, feature replacement, plot expansion, enrichment) ──
    let finalGrid = trimmedGrid;
    if (isSceneMode && geo) {
      try {
        // Window & door enhancement
        setStatus('Enhancing windows & doors...', 'info');
        await new Promise(r => setTimeout(r, 0));
        const winResult = detectAndRegularizeWindows(finalGrid, analysis?.groundPlaneY ?? 0);
        console.log(`[tiles:scene] windows regularized: ${winResult.windowsRegularized}, doors placed: ${winResult.doorsPlaced}`);

        // Clean feature replacement (trees, roads, vehicles at detected positions)
        if (envPositions) {
          setStatus('Replacing detected features...', 'info');
          await new Promise(r => setTimeout(r, 0));
          const treePalette: import('@craft/gen/structures.js').TreeType[] = ['oak', 'birch', 'dark_oak'];
          const replaced = replaceWithCleanFeatures(finalGrid, envPositions, treePalette, 'grass', analysis?.groundPlaneY ?? 0);
          console.log(`[tiles:scene] replaced: ${replaced.trees} trees, ${replaced.roads} road cells, ${replaced.vehicles} vehicles`);
        }

        // Plot expansion — add 8m padding per side
        const { expandGrid } = await import('../../../src/convert/scene-pipeline.js');
        const maxDim = Math.max(finalGrid.width, finalGrid.length);
        const padding = 8 * resolution;
        const newDim = maxDim + padding * 2;
        if (newDim > finalGrid.width || newDim > finalGrid.length) {
          setStatus(`Expanding plot ${finalGrid.width}x${finalGrid.length} → ${newDim}x${newDim}...`, 'info');
          await new Promise(r => setTimeout(r, 0));
          finalGrid = expandGrid(finalGrid, newDim, newDim);
          console.log(`[tiles:scene] plot expansion: ${newDim}x${newDim}`);
        }

        // Scene enrichment — populate roads, trees, fences, ground from OSM + climate data
        setStatus('Scene enrichment — fetching environment data...', 'info');
        await new Promise(r => setTimeout(r, 50));
        const { enrichScene } = await import('../../../src/convert/scene-pipeline.js');
        const plotRadius = Math.max(finalGrid.width, finalGrid.length) / (2 * resolution);
        await enrichScene({
          grid: finalGrid,
          coords: { lat: geo.lat, lng: geo.lng },
          resolution,
          plotRadius,
          capturedEnvironment: envPositions,
          terrainHeightmap: captureResult.terrainHeightmap,
          heightmapWidth: captureResult.heightmapWidth,
          heightmapLength: captureResult.heightmapLength,
          onProgress: (msg) => setStatus(`Enrichment: ${msg}`, 'info'),
        });
      } catch (err) {
        console.warn('[tiles] scene pipeline failed (non-fatal):', err);
        setStatus('Scene enrichment failed — continuing with building only', 'warning');
      }
    }

    const nonAir = finalGrid.countNonAir();
    // Debug: expose grid for inspection
    (window as Record<string, unknown>).__lastTilesGrid = finalGrid;
    console.log('[tiles] palette:', [...finalGrid.palette].join(', '));

    const qualityLabel = analysis
      ? ` (${analysis.dataQuality} quality, confidence ${analysis.confidence.toFixed(1)}/10)`
      : '';
    setStatus(
      `Done — ${finalGrid.width}x${finalGrid.height}x${finalGrid.length}, ${nonAir.toLocaleString()} blocks, ${finalGrid.palette.size} materials${qualityLabel}`,
      'success',
    );

    // Dispose the tile viewer — we don't need it anymore
    disposeViewer();

    // Step 5: Pass grid + analysis + geocode metadata to callback
    // If analysis shows poor/fair quality, the callback can trigger manual selection
    if (onResult && !skipCallback) {
      onResult(finalGrid, `tiles-${geo.formattedAddress}`, analysis, {
        lat: geo.lat,
        lng: geo.lng,
        resolution,
        captureRadius: radiusMeters,
        buildingBounds: bounds,
      });
    }

    return finalGrid;

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

// ─── Post-Processing ─────────────────────────────────────────────────────────

/**
 * Apply essential post-processing to transform raw photogrammetry voxels into
 * clean building geometry. Mirrors the CLI voxelizer's --auto pipeline.
 *
 * Without these steps the browser output is a chaotic mass of noisy colored
 * blocks from baked lighting and surface noise in the Google 3D Tiles data.
 *
 * Steps applied (in order, matching CLI v44 pipeline):
 * 1. Ground plane removal
 * 2. Component cleanup (≥500 voxels)
 * 3. AABB crop (if analysis recommends it)
 * 4-5. Interior fill (dilation=2, two passes)
 * 6. Vegetation strip
 * 7. Morph close — spackle 1-voxel pockmarks
 * 8. Surface smooth + facade flatten
 * 9. Glaze dark windows (before mode filter — glass is PROTECTED)
 * 10. Mode filter — 3D majority-vote surface smoother
 * 11. Sky palette + analysis remaps
 */
async function postProcessTilesGrid(grid: BlockGrid, analysis: AnalysisResult | null, sceneMode = false, resolution = 1): Promise<ExtractedEnvironment | undefined> {
  const t0 = performance.now();
  const rec = analysis?.recommended;

  // Yield helper — lets the browser render status updates between heavy operations
  const yieldUI = () => new Promise<void>(r => setTimeout(r, 0));

  // 1. Ground plane subtraction — MUST run before fill.
  // If terrain is present, fillInteriorGaps treats the entire capture volume as
  // "interior" (terrain creates sealed perimeter), producing massive solid cubes.
  const { removed: groundRemoved, groundY } = removeGroundPlane(grid, 1);
  if (groundRemoved > 0) console.log(`[tiles:pp] ground plane: ${groundRemoved} blocks removed (y=${groundY})`);
  await yieldUI();

  // 2. Component cleanup — remove noise/debris, preserve legitimate building wings.
  // Threshold 500 preserves multi-wing buildings (Pentagon, Capitol) while
  // removing photogrammetry artifacts. Infinity would sever disconnected wings.
  const cleaned = removeSmallComponents(grid, 500);
  if (cleaned > 0) console.log(`[tiles:pp] component cleanup: ${cleaned} blocks removed (< 500 voxels)`);
  await yieldUI();

  // 3. AABB crop — isolate the central building if analysis detected multiple components
  if (rec?.useAABBCrop && analysis) {
    const aabb = analysis.centralAABB;
    const cropped = cropToAABB(grid, aabb.minX, aabb.maxX, aabb.minZ, aabb.maxZ, 2);
    if (cropped > 0) console.log(`[tiles:pp] AABB crop: ${cropped} blocks removed`);
  }
  await yieldUI();

  // 4. Fill interior gaps — 3D masked dilation flood-fill.
  // Mask dilation=2 virtually closes porosity for leak-proof exterior detection,
  // but only original air voxels get filled (crisp geometry preserved).
  const interiorFilled = fillInteriorGaps(grid, 2);
  console.log(`[tiles:pp] interior fill (3D masked): ${interiorFilled} voxels`);
  // 4b. Sky exposure — remove fill in open-air spaces (stadiums, courtyards).
  const openAirCleared = clearOpenAirFill(grid);
  if (openAirCleared > 0) console.log(`[tiles:pp] open-air fill cleared: ${openAirCleared} blocks (no roof above)`);
  await yieldUI();

  // 5. Second fill pass — fill may close more gaps after vegetation strip.
  const interiorFilled2 = fillInteriorGaps(grid, 2);
  if (interiorFilled2 > 0) console.log(`[tiles:pp] interior fill pass 2 (3D masked): ${interiorFilled2} voxels`);
  await yieldUI();

  // 6a. Extract environment positions BEFORE stripping vegetation (scene mode only)
  let envPositions: ExtractedEnvironment | undefined;
  if (sceneMode) {
    envPositions = extractEnvironmentPositions(grid, groundY);
    console.log(`[tiles:pp] env extraction: ${envPositions.trees.length} trees, ${envPositions.roads.cells.size} road cells, ${envPositions.vehicles.length} vehicles`);
  }

  // 6b. Strip vegetation — trees acted as solid walls during fill,
  // preventing holes behind canopy. Now building interior is solid.
  const vegStripped = stripVegetation(grid);
  if (vegStripped > 0) console.log(`[tiles:pp] vegetation strip: ${vegStripped} tree/bush blocks removed`);
  await yieldUI();

  // 7. Morph close — spackle 1-voxel pockmarks/holes in photogrammetry surfaces.
  // Dilation+erosion fills small cracks without changing overall shape.
  // Runs BEFORE smoothSurface so the surface smoother sees healed faces.
  {
    const closed = morphClose3D(grid, 1);
    if (closed > 0) console.log(`[tiles:pp] morph close: ${closed} 1-voxel holes filled`);
  }
  await yieldUI();

  // 8. Geometric smoothing — remove 1-voxel protrusions from photogrammetry noise.
  {
    const surfaceSmoothed = smoothSurface(grid);
    if (surfaceSmoothed > 0) console.log(`[tiles:pp] surface smooth: ${surfaceSmoothed} protrusions removed`);
    // For rectangular buildings, snap noisy walls to dominant flat planes
    if (analysis?.isRectangular) {
      const snapped = flattenFacades(grid, 1);
      if (snapped > 0) console.log(`[tiles:pp] facade flatten: ${snapped} voxels snapped`);
    }
  }
  await yieldUI();

  // 9. Glaze dark exterior blocks as windows BEFORE mode filter.
  // modeFilter3D would erase small dark clusters (windows) as noise.
  // gray_stained_glass is in modeFilter3D's PROTECTED set, so glazing
  // first preserves windows while mode filter smooths walls around them.
  {
    const glazed = glazeDarkWindows(grid, resolution);
    if (glazed > 0) console.log(`[tiles:pp] window glazing: ${glazed} dark blocks → gray_stained_glass`);
    // Synthetic windows for bright facades that lack dark blocks to glaze
    const injected = injectSyntheticWindows(grid, glazed, resolution);
    if (injected > 0) console.log(`[tiles:pp] synthetic windows: ${injected} blocks (bright facade, glazed=${glazed})`);
  }
  await yieldUI();

  // 10. Mode filter — 3x3x3 majority-vote smoother (radius=1).
  // Runs AFTER glazeDarkWindows (glass is protected) and BEFORE sky remap
  // so cyan won't get voted back by majority neighbors.
  const modePasses = rec?.modePasses ?? 1;
  if (modePasses > 0) {
    const modeSmoothed = modeFilter3D(grid, modePasses, 1);
    console.log(`[tiles:pp] mode filter 3x3x3: ${modeSmoothed} blocks (${modePasses} passes)`);
  }
  await yieldUI();

  // 11. Sky contamination remap — blue/cyan skylight baked into tiles surfaces.
  // Runs AFTER mode filter so residual cyan clusters get cleaned up.
  // Only remap cyan — light_blue_terracotta is often legitimate facade color
  // (beige/tan buildings bake slightly blue in photogrammetry)
  const skyRemaps = new Map<string, string>([
    ['minecraft:cyan_terracotta', 'minecraft:stone'],
    ['minecraft:cyan_concrete', 'minecraft:stone'],
  ]);
  const constrained = constrainPalette(grid, skyRemaps);
  if (constrained > 0) console.log(`[tiles:pp] sky palette: ${constrained} blocks remapped`);

  // Also apply analysis-recommended remaps (building-specific material corrections)
  if (rec?.remaps && rec.remaps.size > 0) {
    const remapped = constrainPalette(grid, rec.remaps);
    console.log(`[tiles:pp] auto remap: ${remapped} blocks (${rec.remaps.size} rules)`);
  }
  await yieldUI();

  // 10. glazeBackplane removed: legacy band-aid from carveFacadeShadows era.
  // CIE-Lab color pipeline maps dark pixels to dark blocks natively.
  // AABB raycasting placed black_concrete on exterior courtyard walls.

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`[tiles:pp] post-processing complete in ${elapsed}s`);
  return envPositions;
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

// ─── GLB Export ─────────────────────────────────────────────────────────────

/**
 * Export captured tile meshes as a GLB file for offline CLI re-voxelization.
 * Tries the local schem-receiver first (POST to :3456), falls back to browser download.
 */
async function exportCapturedGLB(group: THREE.Group, address: string): Promise<void> {
  // Pre-process textures: Google 3D Tiles textures are ImageBitmap objects
  // from network fetches. GLTFExporter can't serialize those (produces blob: URLs
  // that are ephemeral). Convert each to a Canvas so the exporter embeds PNG data.
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mat = child.material as THREE.MeshStandardMaterial;
    if (!mat?.map?.image) return;
    const img = mat.map.image as ImageBitmap | HTMLCanvasElement | HTMLImageElement;
    // Skip if already a canvas
    if (img instanceof HTMLCanvasElement) return;
    if (!img.width || !img.height) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img as CanvasImageSource, 0, 0);
      mat.map.image = canvas;
      mat.map.needsUpdate = true;
    } catch {
      // Some textures may not be drawable — skip them
    }
  });

  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const exporter = new GLTFExporter();

  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      group,
      (result) => resolve(result as ArrayBuffer),
      (error) => reject(error),
      { binary: true },
    );
  });

  // Sanitize address for filename: letters, digits, hyphens only
  const sanitized = address
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 80);
  const filename = `tiles-${sanitized}.glb`;

  // Try posting to local receiver server
  try {
    const resp = await fetch(`http://localhost:3456/save/${encodeURIComponent(filename)}`, {
      method: 'POST',
      body: buffer,
    });
    if (resp.ok) {
      console.log(`[tiles] GLB saved via receiver: ${filename} (${buffer.byteLength} bytes)`);
      return;
    }
  } catch {
    // Receiver not running — fall back to browser download
  }

  // Browser download fallback
  const blob = new Blob([buffer], { type: 'model/gltf-binary' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
  console.log(`[tiles] GLB downloaded: ${filename} (${buffer.byteLength} bytes)`);
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
  radiusMeters = 25,
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
