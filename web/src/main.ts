/**
 * Craftmatic Web — main entry point.
 * Wires up navigation, generator, upload, gallery, and 3D viewer.
 */

import './style.css';
import { BlockGrid } from '@craft/schem/types.js';
import { createViewer, applyCutaway, type ViewerState } from '@viewer/scene.js';
import { exportGLB, exportSchem, exportHTML } from '@viewer/exporter.js';
import { initGenerator, type GeneratorConfig } from '@ui/generator.js';
import { initUpload } from '@ui/upload.js';
import { initGallery } from '@ui/gallery.js';

// ─── State ───────────────────────────────────────────────────────────────────

let activeViewer: ViewerState | null = null;
let activeGrid: BlockGrid | null = null;
let inlineViewer: ViewerState | null = null;

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
    <button class="btn btn-secondary btn-sm" id="inline-expand" title="Expand to full viewer">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
        <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
      </svg>
      Expand
    </button>
  `;
  container.appendChild(controlsDiv);

  // Create and mount viewer
  inlineViewer = createViewer(container, grid);

  // Expand button → opens full viewer overlay
  controlsDiv.querySelector('#inline-expand')!.addEventListener('click', () => {
    openFullViewer(grid);
  });
}

// ─── Full Viewer Overlay ─────────────────────────────────────────────────────

const viewerOverlay = document.getElementById('viewer-overlay')!;
const viewerCanvas = document.getElementById('viewer-canvas')!;
const viewerInfo = document.getElementById('viewer-info')!;
const cutawayPanel = document.getElementById('cutaway-panel')!;
const cutawaySlider = document.getElementById('cutaway-slider') as HTMLInputElement;
const cutawayLabel = document.getElementById('cutaway-label')!;

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

// Export GLB
document.getElementById('btn-export-glb')!.addEventListener('click', async () => {
  if (!activeViewer) return;
  showLoading('Exporting GLB...');
  try {
    await exportGLB(activeViewer);
  } catch (err) {
    console.error('GLB export failed:', err);
  }
  hideLoading();
});

// Export .schem
document.getElementById('btn-export-schem')!.addEventListener('click', () => {
  if (!activeGrid) return;
  exportSchem(activeGrid);
});

// Export HTML
document.getElementById('btn-export-html')!.addEventListener('click', () => {
  if (!activeViewer) return;
  exportHTML(activeViewer);
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
  showLoading('Building 3D view...');
  // Defer viewer creation to let loading overlay paint
  requestAnimationFrame(() => {
    showInlineViewer(generatorViewer, grid);
    hideLoading();
  });
});

// ─── Upload ──────────────────────────────────────────────────────────────────

const uploadZone = document.getElementById('upload-zone')!;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const uploadInfo = document.getElementById('upload-info')!;
const uploadViewer = document.getElementById('upload-viewer')!;

initUpload(uploadZone, fileInput, uploadInfo, (grid: BlockGrid, _filename: string) => {
  showLoading('Rendering schematic...');
  requestAnimationFrame(() => {
    showInlineViewer(uploadViewer, grid);
    hideLoading();
  });
});

// ─── Gallery ─────────────────────────────────────────────────────────────────

const galleryGrid = document.getElementById('gallery-grid')!;

initGallery(galleryGrid, (grid: BlockGrid, _label: string) => {
  showLoading('Opening viewer...');
  requestAnimationFrame(() => {
    openFullViewer(grid);
    hideLoading();
  });
});

// ─── Startup ─────────────────────────────────────────────────────────────────
// Ready — user can generate structures, upload files, or browse the gallery.
