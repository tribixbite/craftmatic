/**
 * Craftmatic Web — main entry point.
 * Wires up navigation, generator, upload, gallery, and 3D viewer.
 */

import './style.css';
import * as THREE from 'three';
import { BlockGrid } from '@craft/schem/types.js';
import { createViewer, applyCutaway, type ViewerState } from '@viewer/scene.js';
import { enableSelection } from '@viewer/selection.js';
import { cropToAABB } from '@craft/convert/mesh-filter.js';
import type { AnalysisResult } from '@craft/convert/mesh-filter.js';
import { trimGrid } from '@craft/gen/gen-utils.js';
import { exportGLB, exportSTL, exportOBJ, exportSchem, exportLitematic, exportHTML, exportThreeJSON } from '@viewer/exporter.js';
import { initGenerator, type GeneratorConfig } from '@ui/generator.js';
import { initImport, type PropertyData } from '@ui/import.js';
import { initUpload } from '@ui/upload.js';
import { initGallery } from '@ui/gallery.js';
import { initComparison } from '@ui/comparison.js';
import { initMap3d } from '@ui/map3d.js';
import { initTiles, type TilesResultMeta } from '@ui/tiles.js';

// ─── State ───────────────────────────────────────────────────────────────────

let activeViewer: ViewerState | null = null;
let activeGrid: BlockGrid | null = null;
let inlineViewer: ViewerState | null = null;
/** Base filename (no extension) for exports — derived from address or generator config */
let exportBasename = 'craftmatic';

// ─── Export Filename Helpers ─────────────────────────────────────────────────

/** Slugify a string: lowercase, replace non-alphanumeric runs with hyphens, trim */
function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Build export basename from generator config: type_style_Nf[_seedN] */
function basenameFromConfig(config: GeneratorConfig): string {
  const parts = [config.type, config.style, `${config.floors}f`];
  if (config.seed != null) parts.push(`seed${config.seed}`);
  return parts.join('_');
}

/** Build export basename from property address */
function basenameFromAddress(address: string): string {
  const slug = slugify(address);
  // Cap at 80 chars to avoid filesystem issues
  return slug.length > 80 ? slug.slice(0, 80).replace(/-$/, '') : slug;
}

// ─── Tab Navigation ──────────────────────────────────────────────────────────

const tabs = document.querySelectorAll<HTMLButtonElement>('.nav-tab');
const tabContents = document.querySelectorAll<HTMLElement>('.tab-content');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset['tab']!;
    tabs.forEach(t => t.classList.toggle('active', t === tab));
    tabContents.forEach(tc => tc.classList.toggle('active', tc.id === `tab-${target}`));
  });
});

// URL ?tab=tiles (or any tab name) auto-activates that tab on load
const urlTab = new URLSearchParams(location.search).get('tab');
if (urlTab) {
  const match = document.querySelector<HTMLButtonElement>(`.nav-tab[data-tab="${urlTab}"]`);
  if (match) match.click();
}

// ─── Loading Overlay ─────────────────────────────────────────────────────────

const loadingEl = document.getElementById('loading')!;
const loadingText = document.getElementById('loading-text')!;

function showLoading(text: string): void {
  loadingText.textContent = text;
  loadingEl.hidden = false;
}

function hideLoading(): void {
  loadingEl.hidden = true;
}

/** Show a brief error toast on the loading overlay */
function showError(message: string): void {
  loadingText.textContent = message;
  loadingEl.hidden = false;
  setTimeout(() => { loadingEl.hidden = true; }, 2500);
}

// ─── Inline Viewer (embedded in tab panels) ──────────────────────────────────

function showInlineViewer(container: HTMLElement, grid: BlockGrid): void {
  // Dispose previous inline viewer
  if (inlineViewer) {
    inlineViewer.dispose();
    inlineViewer = null;
  }

  // Clear the container
  container.innerHTML = '';
  container.classList.add('inline-viewer');

  // Create controls overlay
  const controlsDiv = document.createElement('div');
  controlsDiv.className = 'inline-viewer-controls';
  controlsDiv.innerHTML = `
    <div class="inline-cutaway-group">
      <input type="range" id="inline-cutaway" class="inline-cutaway-slider"
        min="0" max="${grid.height}" value="${grid.height}" step="1">
      <span id="inline-cutaway-label" class="inline-cutaway-label">All</span>
    </div>
    <div class="download-dropdown" id="inline-dl-dropdown">
      <button class="btn btn-secondary btn-sm" id="inline-dl-btn" title="Download">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download
        <svg class="download-chevron" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="download-menu download-menu-up" id="inline-dl-menu" hidden>
        <button class="download-item" data-format="schem">.schem<span class="download-desc">Minecraft</span></button>
        <button class="download-item" data-format="litematic">.litematic<span class="download-desc">Litematica</span></button>
        <button class="download-item" data-format="stl">STL<span class="download-desc">3D print</span></button>
        <button class="download-item" data-format="glb">GLB<span class="download-desc">glTF</span></button>
        <button class="download-item" data-format="obj">OBJ<span class="download-desc">Universal</span></button>
        <button class="download-item" data-format="three">Three.js JSON<span class="download-desc">Scene</span></button>
        <button class="download-item" data-format="html">HTML<span class="download-desc">Standalone</span></button>
      </div>
    </div>
    <button class="btn btn-secondary btn-sm" id="inline-expand" title="Expand to full viewer">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
        <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
      </svg>
      Expand
    </button>
  `;
  container.appendChild(controlsDiv);

  // Wire up controls before createViewer — these must work even if WebGL fails
  const inlineCutaway = controlsDiv.querySelector('#inline-cutaway') as HTMLInputElement;
  const inlineCutawayLabel = controlsDiv.querySelector('#inline-cutaway-label')!;
  inlineCutaway.addEventListener('input', () => {
    if (!inlineViewer) return;
    const maxY = parseInt(inlineCutaway.value);
    inlineCutawayLabel.textContent = maxY >= grid.height ? 'All' : `Y:${maxY}`;
    applyCutaway(inlineViewer, maxY);
  });

  // Wire inline download dropdown
  wireDownloadDropdown(
    controlsDiv.querySelector('#inline-dl-dropdown')!,
    controlsDiv.querySelector('#inline-dl-btn')!,
    controlsDiv.querySelector('#inline-dl-menu')!,
    () => inlineViewer,
    () => grid,
  );

  // Expand button → opens full viewer overlay
  controlsDiv.querySelector('#inline-expand')!.addEventListener('click', () => {
    openFullViewer(grid);
  });

  // Create and mount 3D viewer (may fail without WebGL — controls still work)
  inlineViewer = createViewer(container, grid);
}

// ─── Full Viewer Overlay ─────────────────────────────────────────────────────

const viewerOverlay = document.getElementById('viewer-overlay')!;
const viewerCanvas = document.getElementById('viewer-canvas')!;
const viewerInfo = document.getElementById('viewer-info')!;
const cutawayPanel = document.getElementById('cutaway-panel')!;
const cutawaySlider = document.getElementById('cutaway-slider') as HTMLInputElement;
const cutawayLabel = document.getElementById('cutaway-label')!;

/** References for the overlay download dropdown (always visible when viewer open) */
const overlayDownloadMenu = document.getElementById('download-menu')!;
const overlayDownloadDropdown = document.getElementById('download-dropdown')!;

function openFullViewer(grid: BlockGrid): void {
  // Dispose previous viewer
  if (activeViewer) {
    activeViewer.dispose();
    activeViewer = null;
  }

  activeGrid = grid;
  viewerCanvas.innerHTML = '';
  viewerOverlay.hidden = false;

  const nonAir = grid.countNonAir();
  viewerInfo.innerHTML = `<b>Craftmatic</b> &mdash; <span class="accent">${grid.width}x${grid.height}x${grid.length}</span> &mdash; ${nonAir.toLocaleString()} blocks &mdash; ${grid.palette.size} materials`;

  // Setup cutaway slider
  cutawaySlider.max = String(grid.height);
  cutawaySlider.value = String(grid.height);
  cutawayLabel.textContent = 'All';
  cutawayPanel.hidden = true;

  // Always show the download dropdown in the overlay
  overlayDownloadMenu.hidden = false;
  overlayDownloadDropdown.classList.add('open');

  activeViewer = createViewer(viewerCanvas, grid);
}

function closeFullViewer(): void {
  viewerOverlay.hidden = true;
  cutawayPanel.hidden = true;
  if (activeViewer) {
    activeViewer.dispose();
    activeViewer = null;
  }
}

// Close viewer
document.getElementById('btn-close-viewer')!.addEventListener('click', closeFullViewer);

// Cutaway toggle
document.getElementById('btn-cutaway')!.addEventListener('click', () => {
  const btn = document.getElementById('btn-cutaway')!;
  const isActive = cutawayPanel.hidden;
  cutawayPanel.hidden = !isActive;
  btn.classList.toggle('active', isActive);
  if (!isActive && activeViewer) {
    // Reset cutaway
    cutawaySlider.value = String(activeGrid!.height);
    cutawayLabel.textContent = 'All';
    applyCutaway(activeViewer, activeGrid!.height);
  }
});

// Cutaway slider input
cutawaySlider.addEventListener('input', () => {
  if (!activeViewer || !activeGrid) return;
  const maxY = parseInt(cutawaySlider.value);
  cutawayLabel.textContent = maxY >= activeGrid.height ? 'All' : `Y:${maxY}`;
  applyCutaway(activeViewer, maxY);
});

// ─── Download Dropdown ──────────────────────────────────────────────────────

/** Shared wiring for download dropdowns (overlay viewer + inline viewers).
 *  When alwaysOpen is true, the button click doesn't toggle the menu closed. */
function wireDownloadDropdown(
  dropdownEl: HTMLElement,
  btnEl: HTMLElement,
  menuEl: HTMLElement,
  getViewer: () => ViewerState | null,
  getGrid: () => BlockGrid | null,
  alwaysOpen = false,
): void {
  btnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (alwaysOpen) return; // overlay dropdown stays open
    const isOpen = !menuEl.hidden;
    menuEl.hidden = isOpen;
    dropdownEl.classList.toggle('open', !isOpen);
  });
  menuEl.addEventListener('click', (e) => e.stopPropagation());

  menuEl.querySelectorAll<HTMLButtonElement>('.download-item').forEach(item => {
    item.addEventListener('click', async () => {
      const format = item.dataset['format'];
      if (!alwaysOpen) {
        menuEl.hidden = true;
        dropdownEl.classList.remove('open');
      }
      const viewer = getViewer();
      const grid = getGrid();

      try {
        switch (format) {
          case 'schem':
            if (!grid) return;
            exportSchem(grid, `${exportBasename}.schem`);
            break;
          case 'litematic':
            if (!grid) return;
            exportLitematic(grid, `${exportBasename}.litematic`);
            break;
          case 'stl':
            if (!viewer) return;
            showLoading('Exporting STL...');
            await exportSTL(viewer, `${exportBasename}.stl`);
            hideLoading();
            break;
          case 'glb':
            if (!viewer) return;
            showLoading('Exporting GLB...');
            await exportGLB(viewer, `${exportBasename}.glb`);
            hideLoading();
            break;
          case 'obj':
            if (!viewer) return;
            showLoading('Exporting OBJ...');
            await exportOBJ(viewer, `${exportBasename}.obj`);
            hideLoading();
            break;
          case 'three':
            if (!viewer) return;
            exportThreeJSON(viewer, `${exportBasename}-scene.json`);
            break;
          case 'html':
            if (!viewer) return;
            exportHTML(viewer, `${exportBasename}.html`);
            break;
        }
      } catch (err) {
        console.error(`${format} export failed:`, err);
        showError(`${format?.toUpperCase()} export failed`);
        hideLoading();
      }
    });
  });
}

// Wire the overlay viewer's download dropdown (always visible)
wireDownloadDropdown(
  document.getElementById('download-dropdown')!,
  document.getElementById('btn-download')!,
  document.getElementById('download-menu')!,
  () => activeViewer,
  () => activeGrid,
  true, // always open in overlay
);

// Close non-overlay dropdowns on outside click; overlay dropdown stays open
document.addEventListener('click', () => {
  document.querySelectorAll<HTMLElement>('.download-menu').forEach(m => {
    // Skip the overlay download menu — it should always stay visible
    if (m.id === 'download-menu' && !viewerOverlay.hidden) return;
    m.hidden = true;
    m.parentElement?.classList.remove('open');
  });
});

// Fullscreen
document.getElementById('btn-fullscreen')!.addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    viewerOverlay.requestFullscreen?.();
  }
});

// Escape to close
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !viewerOverlay.hidden) {
    closeFullViewer();
  }
});

// ─── Generator ───────────────────────────────────────────────────────────────

const generatorControls = document.getElementById('generator-controls')!;
const generatorViewer = document.getElementById('generator-viewer')!;

initGenerator(generatorControls, (grid: BlockGrid, _config: GeneratorConfig) => {
  exportBasename = basenameFromConfig(_config);
  showLoading('Building 3D view...');
  // Double-defer: rAF lets overlay paint, setTimeout yields for rendering
  requestAnimationFrame(() => setTimeout(() => {
    try {
      showInlineViewer(generatorViewer, grid);
    } catch (err) {
      // Controls already attached by showInlineViewer — just add fallback message
      console.warn('3D viewer failed:', err);
      const fallback = document.createElement('div');
      fallback.className = 'viewer-fallback';
      fallback.textContent = '3D preview unavailable. Your structure was generated successfully.';
      generatorViewer.appendChild(fallback);
    } finally {
      hideLoading();
    }
  }, 0));
});

// ─── Import ─────────────────────────────────────────────────────────────────

const importControls = document.getElementById('import-controls')!;
const importViewer = document.getElementById('import-viewer')!;

initImport(importControls, importViewer, (grid: BlockGrid, _property: PropertyData) => {
  exportBasename = basenameFromAddress(_property.address);
  showLoading('Building 3D view...');
  requestAnimationFrame(() => setTimeout(() => {
    try {
      showInlineViewer(importViewer, grid);
    } catch (err) {
      console.warn('3D viewer failed:', err);
      const fallback = document.createElement('div');
      fallback.className = 'viewer-fallback';
      fallback.textContent = '3D preview unavailable. Your structure was generated successfully.';
      importViewer.appendChild(fallback);
    } finally {
      hideLoading();
    }
  }, 0));
});

// ─── Upload ──────────────────────────────────────────────────────────────────

const uploadZone = document.getElementById('upload-zone')!;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const uploadInfo = document.getElementById('upload-info')!;
const uploadViewer = document.getElementById('upload-viewer')!;

initUpload(uploadZone, fileInput, uploadInfo, (grid: BlockGrid, _filename: string) => {
  // Use the uploaded filename (sans extension) as export basename
  exportBasename = _filename.replace(/\.[^.]+$/, '') || 'upload';
  showLoading('Rendering schematic...');
  requestAnimationFrame(() => setTimeout(() => {
    try {
      showInlineViewer(uploadViewer, grid);
    } catch (err) {
      console.warn('3D viewer failed:', err);
      const fallback = document.createElement('div');
      fallback.className = 'viewer-fallback';
      fallback.textContent = '3D preview unavailable. Upload succeeded.';
      uploadViewer.appendChild(fallback);
    } finally {
      hideLoading();
    }
  }, 0));
});

// ─── Gallery ─────────────────────────────────────────────────────────────────

const galleryGrid = document.getElementById('gallery-grid')!;

initGallery(galleryGrid, (grid: BlockGrid, _label: string) => {
  exportBasename = slugify(_label) || 'gallery';
  showLoading('Opening viewer...');
  requestAnimationFrame(() => setTimeout(() => {
    try {
      openFullViewer(grid);
    } catch (err) {
      console.warn('3D viewer failed:', err);
      showError('3D viewer requires WebGL');
    } finally {
      hideLoading();
    }
  }, 0));
});

// ─── Comparison ─────────────────────────────────────────────────────────────

const comparisonRoot = document.getElementById('comparison-root')!;
initComparison(comparisonRoot, (grid, label) => {
  exportBasename = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'comparison';
  showLoading('Building 3D view...');
  requestAnimationFrame(() => setTimeout(() => {
    try {
      openFullViewer(grid);
    } catch (err) {
      console.warn('3D viewer failed:', err);
      showError('3D viewer requires WebGL');
    } finally {
      hideLoading();
    }
  }, 0));
});

// ─── Map (Google 3D Tiles) ──────────────────────────────────────────────────

const map3dRoot = document.getElementById('map3d-root')!;
initMap3d(map3dRoot);

// ─── Tiles (3D Tiles → Schematic) ──────────────────────────────────────────

const tilesRoot = document.getElementById('tiles-root')!;
initTiles(tilesRoot, (grid, label, analysis, meta) => {
  exportBasename = slugify(label) || 'tiles';

  // Confidence threshold: show manual selection when auto-detection is unreliable
  const SELECTION_THRESHOLD = 7;
  const needsSelection = analysis && analysis.confidence < SELECTION_THRESHOLD;

  showLoading(needsSelection ? 'Low confidence — preparing selection...' : 'Building 3D view...');
  requestAnimationFrame(() => setTimeout(() => {
    try {
      showInlineViewer(tilesRoot, grid);

      if (needsSelection && inlineViewer) {
        // Show selection banner with instructions
        showTilesSelectionBanner(tilesRoot, grid, analysis!, meta);
      }
    } catch (err) {
      console.warn('3D viewer failed:', err);
      const fallback = document.createElement('div');
      fallback.className = 'viewer-fallback';
      fallback.textContent = '3D preview unavailable. Voxelization succeeded — use download buttons above.';
      tilesRoot.appendChild(fallback);
    } finally {
      hideLoading();
    }
  }, 0));
});

// ─── Satellite Overlay for Selection ──────────────────────────────────────────

/**
 * Fetch a Google Static Maps satellite image and overlay it on the ground
 * plane of the 3D viewer. Provides spatial context (roads, neighbors) so the
 * user can identify the target building during manual XZ selection.
 *
 * The image is centered on the geocoded lat/lng and scaled to cover slightly
 * more area than the voxel grid for surrounding context.
 *
 * @returns The overlay mesh (caller must dispose), or null on failure.
 */
async function addSatelliteOverlay(
  scene: THREE.Scene,
  meta: TilesResultMeta,
  grid: BlockGrid,
): Promise<THREE.Mesh | null> {
  const apiKey = localStorage.getItem('craftmatic_map3d_api_key')
    ?? localStorage.getItem('craftmatic_google_streetview_key')
    ?? '';
  if (!apiKey) return null;

  const { lat, lng, resolution } = meta;

  // Grid extent in meters — at resolution=1, 1 block = 1 meter
  const widthM = grid.width / resolution;
  const lengthM = grid.length / resolution;

  // Cover 2.5x the grid area to show surrounding streets and buildings
  const coverageM = Math.max(widthM, lengthM) * 2.5;

  // Calculate zoom level for 640px to cover the desired area:
  //   metersPerPx = 156543.03392 * cos(lat_rad) / 2^zoom
  //   coverage = 640 * metersPerPx → zoom = log2(640 * 156543.03392 * cos(lat_rad) / coverage)
  const latRad = lat * Math.PI / 180;
  const zoomExact = Math.log2(640 * 156543.03392 * Math.cos(latRad) / coverageM);
  const zoom = Math.min(21, Math.max(15, Math.round(zoomExact)));

  // Actual coverage at the snapped integer zoom
  const metersPerPx = 156543.03392 * Math.cos(latRad) / Math.pow(2, zoom);
  const actualCoverageM = 640 * metersPerPx;

  // Fetch satellite image from Google Static Maps API
  const url = `https://maps.googleapis.com/maps/api/staticmap`
    + `?center=${lat},${lng}&zoom=${zoom}&size=640x640`
    + `&maptype=satellite&key=${apiKey}`;

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.crossOrigin = 'anonymous'; // required for Three.js texture use
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Failed to load satellite image'));
    el.src = url;
  });

  const texture = new THREE.Texture(img);
  texture.needsUpdate = true;
  // Sharpen: linear filter looks better for satellite imagery
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  // Plane size in world/block coords: actual coverage in meters × resolution
  const planeSizeBlocks = actualCoverageM * resolution;

  const geo = new THREE.PlaneGeometry(planeSizeBlocks, planeSizeBlocks);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const plane = new THREE.Mesh(geo, mat);
  // PlaneGeometry is XY by default — rotate to lie flat on XZ ground
  plane.rotation.x = -Math.PI / 2;
  // Position just below the voxel ground level to avoid z-fighting
  plane.position.y = -0.5;
  plane.renderOrder = -1;
  scene.add(plane);

  console.log(`[satellite] overlay: zoom=${zoom}, coverage=${actualCoverageM.toFixed(0)}m, plane=${planeSizeBlocks.toFixed(0)} blocks`);
  return plane;
}

/**
 * Show manual selection banner + enable XZ rectangle selection on the viewer.
 * Appears when auto-detection confidence is below threshold.
 */
function showTilesSelectionBanner(
  container: HTMLElement,
  grid: BlockGrid,
  analysis: AnalysisResult,
  meta: TilesResultMeta | null,
): void {
  if (!inlineViewer) return;

  // Create a banner above the viewer
  const banner = document.createElement('div');
  banner.className = 'tiles-selection-banner';
  banner.innerHTML = `
    <div class="tiles-selection-info">
      <strong>Low confidence (${analysis.confidence.toFixed(1)}/10)</strong> —
      Auto-detection may be inaccurate. Tap two corners to outline the building, or skip to use as-is.
    </div>
    <div class="tiles-selection-actions">
      <button class="btn btn-primary btn-sm" id="tiles-sel-start">Select Building</button>
      <button class="btn btn-secondary btn-sm" id="tiles-sel-skip">Skip</button>
    </div>
  `;

  // Insert banner before the viewer canvas
  const viewerCanvas = container.querySelector('.inline-viewer') ?? container.firstChild;
  if (viewerCanvas) {
    container.insertBefore(banner, viewerCanvas);
  } else {
    container.appendChild(banner);
  }

  let selectionCancel: (() => void) | null = null;
  /** Satellite overlay mesh — cleaned up when selection ends */
  let satelliteOverlay: THREE.Mesh | null = null;

  const startBtn = banner.querySelector('#tiles-sel-start') as HTMLButtonElement;
  const skipBtn = banner.querySelector('#tiles-sel-skip') as HTMLButtonElement;

  startBtn.addEventListener('click', async () => {
    if (!inlineViewer) { banner.remove(); return; }

    // Switch to top-down view for easier XZ selection
    const { camera, controls, scene } = inlineViewer;
    const savedPos = camera.position.clone();
    const savedTarget = controls.target.clone();
    const savedMinPolar = controls.minPolarAngle;
    const savedMaxPolar = controls.maxPolarAngle;

    // Move camera directly above looking down — orthographic-like perspective
    const maxDim = Math.max(grid.width, grid.length);
    camera.position.set(0, maxDim * 1.5, 0.01); // tiny Z offset avoids gimbal lock
    controls.target.set(0, 0, 0);
    // Lock vertical rotation to top-down (prevent user from tumbling to 3D view)
    // polarAngle 0 = looking straight down. Allow tiny range for stability.
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = 0.15; // ~8.6° — nearly locked top-down
    controls.update();

    // Overlay satellite imagery on the ground plane for spatial context.
    // Makes the building footprint recognizable relative to roads/neighbors.
    if (meta) {
      addSatelliteOverlay(scene, meta, grid).then(mesh => {
        satelliteOverlay = mesh;
      }).catch(err => {
        console.warn('[selection] satellite overlay failed:', err);
      });
    }

    // Update banner to show selection instructions
    banner.innerHTML = `
      <div class="tiles-selection-info">
        Tap <strong>first corner</strong> of the building boundary, then <strong>second corner</strong>.
        <span class="tiles-sel-hint">ESC or Backspace to undo · Pinch/scroll to zoom</span>
      </div>
      <div class="tiles-selection-actions">
        <button class="btn btn-secondary btn-sm" id="tiles-sel-cancel">Cancel</button>
      </div>
    `;

    const cancelBtn = banner.querySelector('#tiles-sel-cancel') as HTMLButtonElement;

    const { promise, cancel } = enableSelection(
      inlineViewer,
      analysis.groundContactY ?? 0,
    );
    selectionCancel = cancel;

    /** Remove satellite overlay and restore camera */
    function cleanupSelection() {
      if (satelliteOverlay && inlineViewer) {
        inlineViewer.scene.remove(satelliteOverlay);
        satelliteOverlay.geometry.dispose();
        (satelliteOverlay.material as THREE.Material).dispose();
        satelliteOverlay = null;
      }
    }

    /** Restore original camera position and rotation limits after selection */
    function restoreCamera() {
      cleanupSelection();
      if (!inlineViewer) return;
      camera.position.copy(savedPos);
      controls.target.copy(savedTarget);
      controls.minPolarAngle = savedMinPolar;
      controls.maxPolarAngle = savedMaxPolar;
      controls.update();
    }

    cancelBtn.addEventListener('click', () => {
      cancel();
      restoreCamera();
      banner.remove();
    });

    const bounds = await promise;
    selectionCancel = null;

    if (!bounds) {
      restoreCamera();
      banner.remove();
      return;
    }

    // Clean up satellite overlay before rebuilding viewer
    cleanupSelection();

    // Apply crop to grid, then trim to tight AABB for cleaner viewer
    const removed = cropToAABB(grid, bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ, 1);
    const trimmed = trimGrid(grid, 1);
    console.log(`[tiles-selection] cropped ${removed} blocks → ${trimmed.width}x${trimmed.height}x${trimmed.length}`);

    // Remove banner and re-render viewer with trimmed grid
    banner.remove();
    showLoading('Rebuilding view with selection...');
    requestAnimationFrame(() => setTimeout(() => {
      try {
        showInlineViewer(container, trimmed);
      } finally {
        hideLoading();
      }
    }, 0));
  });

  skipBtn.addEventListener('click', () => {
    if (selectionCancel) selectionCancel();
    banner.remove();
  });
}

// ─── Version Badge ──────────────────────────────────────────────────────────

declare const __APP_VERSION__: string;
const versionEl = document.getElementById('app-version');
if (versionEl) {
  versionEl.textContent = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
  versionEl.style.cssText = 'font-family:var(--font-mono,"JetBrains Mono",monospace);font-size:0.7rem;opacity:0.45;letter-spacing:0.02em;';
}

// ─── Service Worker ─────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ─── PWA Install Prompt ──────────────────────────────────────────────────────

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;

// Skip if already installed as standalone app
if (!window.matchMedia('(display-mode: standalone)').matches) {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e as BeforeInstallPromptEvent;
    if (localStorage.getItem('pwa-install-dismissed')) return;
    showInstallBanner();
  });
}

function showInstallBanner(): void {
  const actions = document.querySelector('.nav-actions');
  if (!actions) return;

  const btn = document.createElement('button');
  btn.className = 'btn btn-sm btn-primary nav-install-btn';
  btn.textContent = 'Install';
  btn.title = 'Install Craftmatic for offline use';
  btn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    await deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'dismissed') {
      localStorage.setItem('pwa-install-dismissed', '1');
    }
    deferredInstallPrompt = null;
    btn.remove();
  });

  actions.insertBefore(btn, actions.firstChild);
}

// ─── Startup ─────────────────────────────────────────────────────────────────
// Ready — user can generate structures, upload files, or browse the gallery.
