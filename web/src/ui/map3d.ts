/**
 * Map tab — Google Photorealistic 3D Tiles viewer.
 *
 * Uses Three.js + 3DTilesRendererJS to display Google's 3D map tiles
 * centered on a geocoded address. Supports address search with fly-to,
 * and shares the Google Maps API key from the Import tab.
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
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  getStreetViewApiKey, setStreetViewApiKey, hasStreetViewApiKey,
} from '@ui/import-streetview.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAP_KEY_STORAGE = 'craftmatic_map3d_api_key';
const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';
const GEOCODE_API = 'https://maps.googleapis.com/maps/api/geocode/json';

/** Default location: The Flintstone House, Hillsborough CA */
const DEFAULT_LAT = 37.5313106;
const DEFAULT_LNG = -122.3589559;
const DEFAULT_ADDRESS = '45 Berryessa Way, Hillsborough, CA 94010';

// ─── State ──────────────────────────────────────────────────────────────────

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let tiles: TilesRenderer | null = null;
let reorientation: ReorientationPlugin | null = null;
let animFrameId = 0;
let rootEl: HTMLElement;
let isInitialized = false;

// ─── API Key ────────────────────────────────────────────────────────────────

/** Get the Google Maps API key — checks map-specific storage first, then import tab */
function getApiKey(): string {
  return localStorage.getItem(MAP_KEY_STORAGE) ?? getStreetViewApiKey();
}

/** Save API key to map-specific storage */
function setApiKey(key: string): void {
  if (key.trim()) {
    localStorage.setItem(MAP_KEY_STORAGE, key.trim());
    // Also save to import tab's storage if not already set
    if (!hasStreetViewApiKey()) {
      setStreetViewApiKey(key.trim());
    }
  } else {
    localStorage.removeItem(MAP_KEY_STORAGE);
  }
}

function hasApiKey(): boolean {
  return getApiKey().length > 0;
}

// ─── Geocoding ──────────────────────────────────────────────────────────────

interface GeocodeResult {
  lat: number;
  lng: number;
  formattedAddress: string;
}

async function geocode(address: string): Promise<GeocodeResult | null> {
  const key = getApiKey();
  if (!key) return null;
  const url = `${GEOCODE_API}?address=${encodeURIComponent(address)}&key=${key}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK' || !data.results?.length) return null;
  const loc = data.results[0].geometry.location;
  return {
    lat: loc.lat,
    lng: loc.lng,
    formattedAddress: data.results[0].formatted_address,
  };
}

// ─── Three.js + 3D Tiles Setup ──────────────────────────────────────────────

function initViewer(container: HTMLElement, apiKey: string, lat: number, lng: number): void {
  // Dispose previous
  disposeViewer();

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x0a0a14);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  // Scene + camera
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(
    60,
    container.clientWidth / container.clientHeight,
    1,
    4000,
  );
  // Start camera above and to the side — adjusted after tiles load
  camera.position.set(200, 200, 200);

  // Simple ambient + directional lighting for photorealistic tiles
  scene.add(new THREE.AmbientLight(0xffffff, 1.0));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
  dirLight.position.set(100, 200, 100);
  scene.add(dirLight);

  // Orbit controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.15;
  controls.screenSpacePanning = true;
  controls.maxPolarAngle = Math.PI * 0.85;
  controls.minDistance = 10;
  controls.maxDistance = 2000;

  // 3D Tiles
  tiles = new TilesRenderer();

  // Reorientation plugin: centers tileset so (lat,lng) is at scene origin, Y-up
  reorientation = new ReorientationPlugin({
    lat: lat * THREE.MathUtils.DEG2RAD,
    lon: lng * THREE.MathUtils.DEG2RAD,
    height: 0,
    recenter: true,
  });
  tiles.registerPlugin(reorientation);

  // Google auth
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey }));

  // Draco decompression for mesh data
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }));

  // Performance plugins
  tiles.registerPlugin(new TileCompressionPlugin());
  tiles.registerPlugin(new UpdateOnChangePlugin());
  tiles.registerPlugin(new UnloadTilesPlugin());

  // Camera registration
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);

  scene.add(tiles.group);

  // Render loop
  const animate = () => {
    animFrameId = requestAnimationFrame(animate);
    controls!.update();
    camera!.updateMatrixWorld();
    tiles!.update();
    renderer!.render(scene!, camera!);
  };
  animate();

  // Resize handler
  const onResize = () => {
    if (!renderer || !camera || !container) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (tiles) tiles.setResolutionFromRenderer(camera, renderer);
  };
  window.addEventListener('resize', onResize);
  // Store cleanup ref
  (container as Record<string, unknown>)._map3dResize = onResize;

  isInitialized = true;
}

function disposeViewer(): void {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  animFrameId = 0;
  if (tiles) { tiles.dispose(); tiles = null; }
  if (controls) { controls.dispose(); controls = null; }
  if (renderer) {
    renderer.dispose();
    renderer.domElement.remove();
    renderer = null;
  }
  reorientation = null;
  scene = null;
  camera = null;
  isInitialized = false;
}

// ─── UI Build ───────────────────────────────────────────────────────────────

export function initMap3d(container: HTMLElement): void {
  rootEl = container;
  buildUI();
}

function buildUI(): void {
  const key = getApiKey();
  const masked = key ? `••••${key.slice(-4)}` : '';

  rootEl.innerHTML = `
    <div class="map3d-controls">
      <div class="map3d-search-row">
        <input type="text" class="map3d-search-input" id="map3d-address"
          placeholder="Search address..." value="${escAttr(DEFAULT_ADDRESS)}">
        <button class="btn btn-primary btn-sm" id="map3d-go">Load</button>
      </div>
      <div class="map3d-key-row">
        <label class="map3d-key-label">
          Google API Key
          <span class="map3d-key-status" id="map3d-key-status">
            ${key ? `Key stored: ${masked}` : 'No key — Map Tiles API required'}
          </span>
        </label>
        <div class="map3d-key-input-row">
          <input type="password" class="map3d-key-input" id="map3d-key-input"
            placeholder="${key ? 'Change API key...' : 'Paste Google Maps API key'}">
          <button class="btn btn-secondary btn-sm" id="map3d-key-save">Save</button>
          <a href="https://console.cloud.google.com/apis/library/tile.googleapis.com"
            target="_blank" rel="noopener" class="map3d-key-link">Enable API</a>
        </div>
      </div>
      <div class="map3d-status" id="map3d-status"></div>
    </div>
    <div class="map3d-viewer" id="map3d-viewer">
      ${!key ? `
        <div class="map3d-placeholder">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/>
            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z"/>
          </svg>
          <p>Enter a Google Maps API key to load 3D tiles</p>
          <p class="map3d-placeholder-sub">Requires Map Tiles API enabled on your Google Cloud project</p>
        </div>
      ` : ''}
    </div>
  `;

  // Wire events
  const addrInput = document.getElementById('map3d-address') as HTMLInputElement;
  const goBtn = document.getElementById('map3d-go')!;
  const keyInput = document.getElementById('map3d-key-input') as HTMLInputElement;
  const keySaveBtn = document.getElementById('map3d-key-save')!;

  // Load address
  const loadAddress = async () => {
    const addr = addrInput.value.trim();
    if (!addr) return;
    if (!hasApiKey()) {
      setStatus('Enter an API key first', 'error');
      return;
    }

    setStatus('Geocoding...', 'info');
    const result = await geocode(addr);
    if (!result) {
      setStatus('Address not found', 'error');
      return;
    }

    addrInput.value = result.formattedAddress;
    setStatus(`${result.formattedAddress} — ${result.lat.toFixed(5)}, ${result.lng.toFixed(5)}`, 'info');

    // Always reinitialize viewer for new location (plugin property updates alone
    // don't cause tiles to reload at the new origin)
    const viewerEl = document.getElementById('map3d-viewer')!;
    viewerEl.innerHTML = '';
    setStatus('Loading 3D tiles...', 'info');
    try {
      initViewer(viewerEl, getApiKey(), result.lat, result.lng);
      setStatus(`Loaded — ${result.formattedAddress}`, 'success');
    } catch (err) {
      console.error('3D tiles init failed:', err);
      setStatus('3D tiles failed to load', 'error');
    }
  };

  goBtn.addEventListener('click', loadAddress);
  addrInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadAddress();
  });

  // Save API key
  keySaveBtn.addEventListener('click', () => {
    const val = keyInput.value.trim();
    if (!val) return;
    setApiKey(val);
    keyInput.value = '';
    const statusEl = document.getElementById('map3d-key-status')!;
    statusEl.textContent = `Key stored: ••••${val.slice(-4)}`;
    keySaveBtn.textContent = 'Saved';
    setTimeout(() => { keySaveBtn.textContent = 'Save'; }, 1500);
    // If viewer not yet loaded, trigger initial load
    if (!isInitialized && addrInput.value.trim()) {
      loadAddress();
    }
  });

  // Auto-load default location if key exists (skip geocoding — use hardcoded coords)
  if (key) {
    requestAnimationFrame(() => {
      const viewerEl = document.getElementById('map3d-viewer')!;
      viewerEl.innerHTML = '';
      setStatus('Loading 3D tiles...', 'info');
      try {
        initViewer(viewerEl, getApiKey(), DEFAULT_LAT, DEFAULT_LNG);
        setStatus(`Loaded — ${DEFAULT_ADDRESS}`, 'success');
      } catch (err) {
        console.error('3D tiles init failed:', err);
        setStatus('3D tiles failed to load', 'error');
      }
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function setStatus(msg: string, type: 'info' | 'error' | 'success'): void {
  const el = document.getElementById('map3d-status');
  if (!el) return;
  el.textContent = msg;
  el.className = `map3d-status map3d-status-${type}`;
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
