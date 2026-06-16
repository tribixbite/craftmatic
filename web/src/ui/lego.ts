/**
 * LEGO Set tab — search, select, and voxelize LEGO sets.
 *
 * Set search uses the Rebrickable public CSV downloads (no API key required).
 * 3D models come from LDraw MPD/LDR files downloaded from:
 *   • LDraw OMR: library.ldraw.org/omr  (~1,470 sets)
 *   • BrickLink Studio (export → LDraw)
 *
 * Pipeline: MPD upload → ldraw-parser → ldraw-voxelizer → inline 3D viewer
 */

import { BlockGrid } from '@craft/schem/types.js';
import { parseLDraw, countSteps, type ParsedBrick } from '@engine/ldraw-parser.js';
import { voxelizeLDraw, solidifyColumns, fillSingleVoxelGaps, keepLargestComponent, type VoxelizeOptions } from '@engine/ldraw-voxelizer.js';
import { voxelizeLDrawGeometry } from '@engine/ldraw-geometry.js';
import { extractIoModel } from '@engine/io-extractor.js';
import { parseLxf } from '@engine/lxf-parser.js';
import { studioColorToBlock } from '@engine/studio-colors.js';
import { fetchBffInventory, bffInventoryToLDraw } from '@engine/bff-loader.js';
import {
  ensureCatalog, searchCatalog, getThemes, isLoaded, isInOmr, isOmrLoaded,
  type CatalogSet, type CatalogTheme,
} from '@engine/lego-catalog.js';
import { exportGLB, exportSTL, exportOBJ, exportSchem, exportLitematic, countExportTriangles } from '@viewer/exporter.js';
import type { ViewerState } from '@viewer/scene.js';
import { LDRAW_COLOR_RGB } from '@engine/ldraw-colors.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const OMR_BASE = 'https://library.ldraw.org/library/omr';
// Route through local proxy (Vite in dev, CF Pages Function in prod) to avoid CORS
const OMR_FETCH_BASE = '/ldraw-omr';
// Reconstructed 3D LDR files served locally from clego project (dev server middleware)
const RECONSTRUCTED_BASE = '/lego-reconstructed';
// Lazily loaded set of reconstructed set IDs
let _reconstructedIndex: Set<string> | null = null;
// Lazily loaded map of set base-number → instruction PDF URLs
let _instructionsMap: Record<string, string[]> | null = null;

async function getInstructionsMap(): Promise<Record<string, string[]>> {
  if (_instructionsMap) return _instructionsMap;
  try {
    const r = await fetch('/lego-instructions.json');
    if (r.ok) _instructionsMap = await r.json() as Record<string, string[]>;
  } catch { /* offline */ }
  _instructionsMap ??= {};
  return _instructionsMap;
}

async function getReconstructedIndex(): Promise<Set<string>> {
  if (_reconstructedIndex) return _reconstructedIndex;
  try {
    const r = await fetch('/lego-reconstructed-index.json');
    if (r.ok) {
      const ids: string[] = await r.json();
      _reconstructedIndex = new Set(ids);
    }
  } catch { /* offline or prod — no reconstructed files available */ }
  _reconstructedIndex ??= new Set();
  return _reconstructedIndex;
}

/** Strip the '-1', '-2' etc suffix to get the base set number used in clego filenames. */
function baseSetNum(setNum: string): string {
  return setNum.replace(/-\d+$/, '');
}

// ─── State ───────────────────────────────────────────────────────────────────

let rootEl: HTMLElement;
let onResult: ((grid: BlockGrid, label: string, isCubic: boolean) => void) | null = null;
let selectedSet: CatalogSet | null = null;
let searchResults: CatalogSet[] = [];
/** When true, use 1 stud = 1 block in all axes (no 2.5× vertical stretch). */
let cubicScale = false;
let detailScale = false;
/** When true, fetch real .dat triangle geometry for accurate shape rendering (slow, dev-only). */
let geometryMode = false;
/** When true, render LDraw brick geometry directly as 3D meshes instead of voxelizing. */
let directRenderMode = false;
/** Current parsed bricks for step-slider re-voxelization */
let currentBricks: ParsedBrick[] | null = null;
let currentBricksLabel = '';
let currentBricksColorFn: ((id: number) => string) | undefined;
/** Raw MPD/LDR content for inline sub-model resolution in 3D renderer */
let currentMpdContent: string | undefined;
/** Part definitions bundled inside the loaded .io archive (CustomParts/). */
let currentCustomParts: Map<string, string> | undefined;
/**
 * Persistent 3D viewer instance — kept alive across step-slider drags so
 * setMaxStep() is an O(1) visibility toggle instead of a full rebuild.
 * Imported lazily; type widened to interoperate with both the old shim
 * return type and the new LDrawViewer class.
 */
import type { LDrawViewer as LDrawViewerType } from '@viewer/ldraw/index.js';
let currentLDrawViewer: LDrawViewerType | null = null;
/** Total number of steps in the current model (1 = no step markers) */
let totalSteps = 1;
/**
 * Slider key for the 3D viewer: assembly steps or vertical (plate) layers.
 * Layer mode is what makes the slider useful for Studio .io exports that
 * carry no STEP meta (e.g. 71043: 5,936 bricks, one step).
 */
let sliderMode: 'step' | 'layer' = 'step';
/** Current step being shown (undefined = all steps) */
let currentStep: number | undefined;

// ─── Init ────────────────────────────────────────────────────────────────────

export function initLego(
  controls: HTMLElement,
  _viewer: HTMLElement,
  callback: (grid: BlockGrid, label: string, isCubic: boolean) => void,
): void {
  rootEl = controls;
  onResult = callback;
  buildUI();
  // Auto-detect LDraw parts library and enable 3D Render by default. If the
  // library is present, schedule a background warmup of the ~40 most common
  // bricks so the first model load doesn't pay the full per-part fetch cost.
  fetch('/ldraw-parts/parts/3001.dat', { method: 'HEAD' })
    .then(r => {
      if (r.ok) {
        directRenderMode = true;
        const cb = document.getElementById('lego-direct-render') as HTMLInputElement | null;
        if (cb) cb.checked = true;
        updateScaleControlsVisibility();
        // Idle-callback so warmup never competes with first-paint work.
        const schedule = (window as Window & { requestIdleCallback?: (cb: () => void) => void })
          .requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 500));
        schedule(() => {
          void import('@viewer/ldraw/parts.js').then(({ prewarmCommonParts }) => prewarmCommonParts());
        });
      }
    })
    .catch(() => { /* no parts library — keep voxel mode */ });
  // Pre-load catalog in background so search is instant when user types
  ensureCatalog(msg => setStatus(msg, 'info')).catch(err => {
    setStatus(`Catalog load failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  });
}

// ─── UI Construction ─────────────────────────────────────────────────────────

function buildUI(): void {
  rootEl.innerHTML = `
    <!-- Status (shared) -->
    <div class="lego-status" id="lego-status" hidden></div>
    <div id="lego-progress" hidden style="margin-top:6px;height:4px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden">
      <div id="lego-progress-fill" style="height:100%;width:0%;background:linear-gradient(90deg,#7c3aed,#a78bfa);transition:width 120ms ease-out"></div>
    </div>
    <div id="lego-picked-brick" hidden style="margin-top:6px;padding:6px 8px;background:rgba(124,58,237,0.12);border:1px solid rgba(124,58,237,0.4);border-radius:4px;font-size:0.78rem;line-height:1.5"></div>
    <div id="lego-hover-tooltip" hidden style="position:fixed;z-index:9999;pointer-events:none;padding:4px 8px;background:rgba(0,0,0,0.85);color:#fff;border-radius:4px;font-size:0.7rem;line-height:1.3;white-space:nowrap;font-family:ui-sans-serif,system-ui,sans-serif"></div>
    <div id="lego-help-overlay" hidden style="position:fixed;inset:0;z-index:10000;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.65);backdrop-filter:blur(4px);font-family:ui-sans-serif,system-ui,sans-serif">
      <div style="background:rgba(20,20,28,0.96);border:1px solid rgba(124,58,237,0.5);border-radius:10px;padding:24px 32px;color:#e6e6f0;max-width:480px;box-shadow:0 20px 60px rgba(0,0,0,0.5)">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:18px;gap:12px">
          <h3 style="margin:0;font-size:1rem;letter-spacing:0.04em;text-transform:uppercase;color:#a78bfa">Viewer Controls</h3>
          <span style="font-size:0.7rem;opacity:0.6;flex:1">? to toggle · Esc · click outside</span>
          <button id="lego-help-close" type="button" aria-label="Close help"
            style="background:transparent;border:none;color:#888;font-size:1.4rem;line-height:1;padding:0 4px;cursor:pointer">×</button>
        </div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:10px 16px;font-size:0.82rem;line-height:1.5">
          <kbd style="background:#2a2a36;border:1px solid #3a3a48;border-radius:4px;padding:1px 7px;font-family:ui-monospace,monospace;font-size:0.75rem">I</kbd><span>Isometric (3/4) view</span>
          <kbd style="background:#2a2a36;border:1px solid #3a3a48;border-radius:4px;padding:1px 7px;font-family:ui-monospace,monospace;font-size:0.75rem">F</kbd><span>Front view</span>
          <kbd style="background:#2a2a36;border:1px solid #3a3a48;border-radius:4px;padding:1px 7px;font-family:ui-monospace,monospace;font-size:0.75rem">B</kbd><span>Back view</span>
          <kbd style="background:#2a2a36;border:1px solid #3a3a48;border-radius:4px;padding:1px 7px;font-family:ui-monospace,monospace;font-size:0.75rem">L</kbd><span>Left side</span>
          <kbd style="background:#2a2a36;border:1px solid #3a3a48;border-radius:4px;padding:1px 7px;font-family:ui-monospace,monospace;font-size:0.75rem">R</kbd><span>Right side</span>
          <kbd style="background:#2a2a36;border:1px solid #3a3a48;border-radius:4px;padding:1px 7px;font-family:ui-monospace,monospace;font-size:0.75rem">T</kbd><span>Top-down</span>
          <kbd style="background:#2a2a36;border:1px solid #3a3a48;border-radius:4px;padding:1px 7px;font-family:ui-monospace,monospace;font-size:0.75rem">←&nbsp;/&nbsp;→</kbd><span>Previous / next build step</span>
          <kbd style="background:#2a2a36;border:1px solid #3a3a48;border-radius:4px;padding:1px 7px;font-family:ui-monospace,monospace;font-size:0.75rem">Space</kbd><span>Toggle auto-rotate</span>
          <kbd style="background:#2a2a36;border:1px solid #3a3a48;border-radius:4px;padding:1px 7px;font-family:ui-monospace,monospace;font-size:0.75rem">Esc</kbd><span>Close picked-brick info / help</span>
        </div>
        <div style="margin-top:18px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.08);font-size:0.78rem;line-height:1.6;opacity:0.85">
          <strong style="color:#a78bfa">Mouse:</strong> drag to orbit · scroll to zoom · right-drag to pan · click a brick to inspect · hover for part ID
        </div>
      </div>
    </div>

    <!-- Scale mode toggle -->
    <div class="lego-section lego-scale-row">
      <span class="lego-section-label" style="font-size:0.75rem;opacity:0.7">Scale</span>
      <div class="lego-scale-btns" id="lego-scale-btns">
        <button class="lego-scale-btn active" data-mode="accurate" title="1 plate = 1 block — maximum vertical detail, 2.5× taller than real LEGO proportions">Accurate</button>
        <button class="lego-scale-btn" data-mode="cubic" title="1 stud = 1 block in all axes — correct LEGO proportions, flat models look flat">Cubic</button>
        <button class="lego-scale-btn" data-mode="detail" title="1 plate = 1 block in ALL axes — 2.5× more horizontal detail, captures thin walls and windows">Detail</button>
      </div>
      <label title="Fetch real .dat triangle geometry for accurate shape rendering (dev only — requires /ldraw-parts)" style="display:flex;align-items:center;gap:4px;font-size:0.75rem;opacity:0.8;margin-left:8px;cursor:pointer">
        <input type="checkbox" id="lego-geometry-mode" style="margin:0">
        Geometry
      </label>
      <label title="Render actual LDraw brick geometry as 3D meshes — closest to assembled LEGO set (dev only)" style="display:flex;align-items:center;gap:4px;font-size:0.75rem;opacity:0.8;margin-left:8px;cursor:pointer">
        <input type="checkbox" id="lego-direct-render" style="margin:0">
        3D Render
      </label>
      <label title="Slowly orbit the camera around the model — useful for showcase / comparison" style="display:flex;align-items:center;gap:4px;font-size:0.75rem;opacity:0.8;margin-left:8px;cursor:pointer">
        <input type="checkbox" id="lego-auto-rotate" style="margin:0">
        Rotate
      </label>
      <label title="Hide brick fills, show only edge lines — useful for inspecting connectivity" style="display:flex;align-items:center;gap:4px;font-size:0.75rem;opacity:0.8;margin-left:8px;cursor:pointer">
        <input type="checkbox" id="lego-wireframe" style="margin:0">
        Wireframe
      </label>
      <label title="Show FPS / draw calls / triangle count overlay (dev)" style="display:flex;align-items:center;gap:4px;font-size:0.75rem;opacity:0.8;margin-left:8px;cursor:pointer">
        <input type="checkbox" id="lego-stats" style="margin:0">
        Stats
      </label>
      <label title="Background color (and matching studio backdrop)" style="display:flex;align-items:center;gap:4px;font-size:0.75rem;opacity:0.8;margin-left:8px;cursor:pointer">
        <input type="color" id="lego-bg-color" value="#2d2d3d" style="width:20px;height:20px;border:none;background:transparent;padding:0;cursor:pointer">
        BG
      </label>
      <span id="lego-view-presets" style="display:inline-flex;gap:2px;margin-left:8px">
        <button class="lego-view-btn" data-view="iso"   title="3/4 isometric view (default)" style="font-size:0.7rem;padding:2px 6px;border-radius:3px">iso</button>
        <button class="lego-view-btn" data-view="front" title="Front view" style="font-size:0.7rem;padding:2px 6px;border-radius:3px">F</button>
        <button class="lego-view-btn" data-view="left"  title="Left view"  style="font-size:0.7rem;padding:2px 6px;border-radius:3px">L</button>
        <button class="lego-view-btn" data-view="right" title="Right view" style="font-size:0.7rem;padding:2px 6px;border-radius:3px">R</button>
        <button class="lego-view-btn" data-view="back"  title="Back view"  style="font-size:0.7rem;padding:2px 6px;border-radius:3px">B</button>
        <button class="lego-view-btn" data-view="top"   title="Top view"   style="font-size:0.7rem;padding:2px 6px;border-radius:3px">T</button>
        <button id="lego-flip-front" type="button" title="If F shows the wrong side, click to flip the detected front/back" style="font-size:0.7rem;padding:2px 6px;border-radius:3px">↻F</button>
      </span>
      <select id="lego-export-png" title="Export current view as PNG at chosen size" style="margin-left:8px;font-size:0.7rem;padding:2px 4px;border-radius:3px">
        <option value="">PNG…</option>
        <option value="1920x1080">1920×1080 HD</option>
        <option value="2560x1440">2560×1440 QHD</option>
        <option value="3840x2160">3840×2160 4K</option>
        <option value="7680x4320">7680×4320 8K</option>
      </select>
      <select id="lego-export-model" title="Download the loaded set as a 3D model or Minecraft schematic" style="margin-left:6px;font-size:0.7rem;padding:2px 4px;border-radius:3px">
        <option value="">Download…</option>
        <optgroup label="3D model">
          <option value="glb">GLB (.glb)</option>
          <option value="obj">OBJ (.obj)</option>
          <option value="stl">STL (.stl)</option>
        </optgroup>
        <optgroup label="Minecraft">
          <option value="schem">Schematic (.schem)</option>
          <option value="litematic">Litematica (.litematic)</option>
        </optgroup>
        <optgroup label="Data">
          <option value="csv">Parts list (.csv)</option>
        </optgroup>
      </select>
    </div>

    <!-- Assembly step / vertical layer slider (hidden until a model loads) -->
    <div class="lego-section lego-scale-row" id="lego-step-row" hidden style="display:none">
      <button id="lego-step-mode" type="button"
        title="Toggle between assembly steps and vertical layers (one plate per layer)"
        style="background:transparent;border:1px solid rgba(167,139,250,0.35);color:#a78bfa;border-radius:4px;padding:2px 6px;font-size:0.72rem;cursor:pointer;font-family:inherit">Step</button>
      <button id="lego-step-play" type="button" title="Auto-advance (click to play/pause)"
        style="background:rgba(124,58,237,0.12);border:1px solid rgba(124,58,237,0.45);color:#a78bfa;border-radius:4px;padding:2px 8px;font-size:0.78rem;cursor:pointer;font-family:inherit">▶</button>
      <input type="range" id="lego-step-slider" min="1" max="1" value="1" style="flex:1;min-width:60px">
      <span id="lego-step-label" style="font-size:0.75rem;min-width:3.5em;text-align:right">1/1</span>
    </div>

    <!-- Explode slider (hidden until 3D direct-render viewer is mounted) -->
    <div class="lego-section lego-scale-row" id="lego-explode-row" hidden style="display:none">
      <span class="lego-section-label" style="font-size:0.75rem;opacity:0.7">Explode</span>
      <input type="range" id="lego-explode-slider" min="0" max="100" value="0" style="flex:1;min-width:60px">
      <span id="lego-explode-label" style="font-size:0.75rem;min-width:3.5em;text-align:right">0%</span>
    </div>

    <!-- Primary: Upload LDraw file -->
    <div class="lego-section">
      <div class="lego-label-row">
        <span class="lego-section-label">Upload LDraw File</span>
        <span class="lego-section-sub">from LDraw OMR or BrickLink Studio</span>
      </div>
      <label class="lego-upload-zone" id="lego-upload-zone">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="7" width="20" height="14" rx="2"/>
          <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
          <circle cx="8" cy="4" r="1"/><circle cx="12" cy="4" r="1"/><circle cx="16" cy="4" r="1"/>
        </svg>
        <span class="lego-upload-zone-text">
          Drop <code>.mpd</code> / <code>.ldr</code> / <code>.io</code> / <code>.lxf</code> here, or click to browse
        </span>
        <input type="file" id="lego-mpd-input" accept=".mpd,.ldr,.io,.lxf" hidden>
      </label>
      <div class="lego-omr-quick">
        <span class="lego-omr-label">Get files:</span>
        <a href="https://library.ldraw.org/omr/sets/" target="_blank" rel="noopener" class="lego-ext-link">LDraw OMR ↗</a>
        <a href="https://www.bricklink.com/v3/studio/studio.page" target="_blank" rel="noopener" class="lego-ext-link">BrickLink Studio ↗</a>
      </div>
    </div>

    <!-- Divider -->
    <div class="lego-divider"><span>or search for a set</span></div>

    <!-- Search (no API key required — uses public CSV) -->
    <div class="lego-section">
      <div class="lego-search-row">
        <input type="text" id="lego-search" class="lego-input lego-search-input"
          placeholder="Set name or number (e.g. 75192, Falcon, Technic)…">
        <button class="btn btn-primary btn-sm" id="lego-search-btn">Search</button>
      </div>
      <div class="lego-filters">
        <select id="lego-theme" class="lego-select" title="Filter by theme">
          <option value="">All Themes</option>
        </select>
        <input type="number" id="lego-year-min" class="lego-input lego-year-input"
          placeholder="From" min="1950" max="2030" title="From year">
        <input type="number" id="lego-year-max" class="lego-input lego-year-input"
          placeholder="To" min="1950" max="2030" title="To year">
      </div>
    </div>

    <!-- Results -->
    <div class="lego-results" id="lego-results" hidden>
      <div class="lego-results-grid" id="lego-results-grid"></div>
    </div>

    <!-- Selected set detail -->
    <div class="lego-detail" id="lego-detail" hidden>
      <div class="lego-detail-inner" id="lego-detail-inner"></div>
      <div class="lego-omr-links" id="lego-omr-links"></div>
    </div>
  `;

  wireEvents();
}

/**
 * Toggle the help overlay. Uses both the `hidden` attribute AND inline
 * `style.display` because the overlay's inline `display:flex` would otherwise
 * override `hidden` (inline style wins over the UA default for [hidden]).
 */
function setHelpOpen(open: boolean): void {
  const help = document.getElementById('lego-help-overlay');
  if (!help) return;
  help.hidden = !open;
  help.style.display = open ? 'flex' : 'none';
}

function wireEvents(): void {
  // ── Scale mode toggle ──────────────────────────────────────────────────────
  document.getElementById('lego-scale-btns')?.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest('[data-mode]') as HTMLElement | null;
    if (!btn) return;
    const mode = btn.dataset['mode'];
    cubicScale = mode === 'cubic';
    detailScale = mode === 'detail';
    document.querySelectorAll('.lego-scale-btn').forEach(b =>
      b.classList.toggle('active', b === btn));
    if (currentBricks) void voxelizeAndDisplay(currentBricks, currentBricksLabel, currentBricksColorFn);
  });

  // ── Geometry mode toggle ───────────────────────────────────────────────────
  document.getElementById('lego-geometry-mode')?.addEventListener('change', e => {
    geometryMode = (e.target as HTMLInputElement).checked;
    if (currentBricks) void voxelizeAndDisplay(currentBricks, currentBricksLabel, currentBricksColorFn);
  });

  // ── Direct 3D render toggle ───────────────────────────────────────────────
  document.getElementById('lego-direct-render')?.addEventListener('change', e => {
    directRenderMode = (e.target as HTMLInputElement).checked;
    updateScaleControlsVisibility();
    if (currentBricks) void voxelizeAndDisplay(currentBricks, currentBricksLabel, currentBricksColorFn);
  });
  updateScaleControlsVisibility();

  // ── Auto-rotation toggle ──────────────────────────────────────────────────
  document.getElementById('lego-auto-rotate')?.addEventListener('change', e => {
    const on = (e.target as HTMLInputElement).checked;
    currentLDrawViewer?.setAutoRotate(on);
  });

  // ── Wireframe toggle ──────────────────────────────────────────────────────
  document.getElementById('lego-wireframe')?.addEventListener('change', e => {
    const on = (e.target as HTMLInputElement).checked;
    currentLDrawViewer?.setWireframe(on);
  });

  // ── Stats overlay toggle ──────────────────────────────────────────────────
  document.getElementById('lego-stats')?.addEventListener('change', e => {
    const on = (e.target as HTMLInputElement).checked;
    currentLDrawViewer?.setStatsOverlay(on);
  });

  // ── Background color picker ───────────────────────────────────────────────
  document.getElementById('lego-bg-color')?.addEventListener('input', e => {
    const hex = parseInt((e.target as HTMLInputElement).value.replace('#', ''), 16);
    if (!isNaN(hex)) currentLDrawViewer?.setBackgroundColor(hex);
  });

  // ── View preset buttons ───────────────────────────────────────────────────
  document.getElementById('lego-view-presets')?.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest('[data-view]') as HTMLElement | null;
    const name = btn?.dataset['view'] as 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | undefined;
    if (name) currentLDrawViewer?.setView(name);
  });
  document.getElementById('lego-flip-front')?.addEventListener('click', () => {
    currentLDrawViewer?.flipFront();
  });

  // ── Keyboard shortcuts (active only when LEGO tab is showing) ─────────────
  document.addEventListener('keydown', e => {
    // Don't intercept when typing in a text/number input
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' || target.isContentEditable) return;
    // Only act when LEGO tab is the active view (heuristic: viewer is visible)
    const viewer = document.getElementById('lego-viewer');
    if (!viewer || viewer.offsetParent === null) return;

    // Help-overlay open/close and Esc-dismiss must work even when no model is
    // loaded yet — otherwise the viewer-gate below traps the overlay.
    const key = e.key.toLowerCase();
    if (key === 'escape') {
      const help = document.getElementById('lego-help-overlay');
      if (help && !help.hidden) { setHelpOpen(false); e.preventDefault(); return; }
      const picked = document.getElementById('lego-picked-brick');
      if (picked) picked.hidden = true;
      return;
    }
    if (key === '?' || (key === '/' && e.shiftKey)) {
      const help = document.getElementById('lego-help-overlay');
      if (help) setHelpOpen(help.hidden);
      e.preventDefault();
      return;
    }

    if (!currentLDrawViewer) return;

    switch (e.key.toLowerCase()) {
      case 'i': currentLDrawViewer.setView('iso'); e.preventDefault(); break;
      case 'f': currentLDrawViewer.setView('front'); e.preventDefault(); break;
      case 'b': currentLDrawViewer.setView('back'); e.preventDefault(); break;
      case 'l': currentLDrawViewer.setView('left'); e.preventDefault(); break;
      case 'r': currentLDrawViewer.setView('right'); e.preventDefault(); break;
      case 't': currentLDrawViewer.setView('top'); e.preventDefault(); break;
      case ' ': {
        const cb = document.getElementById('lego-auto-rotate') as HTMLInputElement | null;
        if (cb) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
        e.preventDefault();
        break;
      }
      case 'arrowleft':
      case 'arrowright': {
        const slider = document.getElementById('lego-step-slider') as HTMLInputElement | null;
        if (!slider) break;
        stopStepPlay();
        const cur = parseInt(slider.value, 10);
        const max = parseInt(slider.max, 10);
        const min = parseInt(slider.min, 10);
        const delta = e.key.toLowerCase() === 'arrowleft' ? -1 : 1;
        const next = Math.max(min, Math.min(max, cur + delta));
        if (next !== cur) {
          slider.value = String(next);
          slider.dispatchEvent(new Event('input', { bubbles: true }));
        }
        e.preventDefault();
        break;
      }
    }
  });

  // Click overlay backdrop or × button to close
  document.getElementById('lego-help-overlay')?.addEventListener('click', e => {
    const overlay = e.currentTarget as HTMLElement;
    const closeBtn = (e.target as HTMLElement).closest('#lego-help-close');
    if (closeBtn || e.target === overlay) setHelpOpen(false);
  });
  // Belt-and-suspenders: a window-level capture-phase Esc listener that
  // ALWAYS closes the help overlay if it's visible, regardless of which
  // element has focus or what other handlers might absorb the event.
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const help = document.getElementById('lego-help-overlay');
    if (help && !help.hidden) {
      setHelpOpen(false);
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, { capture: true });

  // ── PNG export ────────────────────────────────────────────────────────────
  document.getElementById('lego-export-png')?.addEventListener('change', e => {
    const sel = e.target as HTMLSelectElement;
    const dim = sel.value;
    sel.value = ''; // reset back to placeholder
    if (!dim || !currentLDrawViewer) return;
    const [wStr, hStr] = dim.split('x');
    const w = parseInt(wStr!, 10);
    const h = parseInt(hStr!, 10);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    setStatus(`Rendering ${w}×${h} PNG…`, 'info');
    try {
      const dataUrl = currentLDrawViewer.captureScreenshotAt(w, h);
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `${currentBricksLabel.replace(/\.[^.]+$/, '')}-${w}x${h}.png`;
      a.click();
      setStatus(`Exported ${w}×${h} PNG`, 'success');
    } catch (err) {
      setStatus(`Export failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  });

  // ── Model / schematic export ────────────────────────────────────────────────
  document.getElementById('lego-export-model')?.addEventListener('change', e => {
    const sel = e.target as HTMLSelectElement;
    const fmt = sel.value;
    sel.value = ''; // reset to placeholder
    if (!fmt) return;
    void exportLoadedModel(fmt);
  });

  // ── Explode slider ────────────────────────────────────────────────────────
  document.getElementById('lego-explode-slider')?.addEventListener('input', e => {
    const pct = parseInt((e.target as HTMLInputElement).value, 10);
    const label = document.getElementById('lego-explode-label');
    if (label) label.textContent = `${pct}%`;
    // 0-100 → 0-1.5. 1.5× lets the bricks fly far apart for engineering-view
    // inspection without flying out of the camera frustum on typical zoom.
    currentLDrawViewer?.setExplodeFactor(pct / 100 * 1.5);
  });

  // ── Step playback (▶ button auto-advances steps) ───────────────────────────
  let stepPlayTimer: ReturnType<typeof setInterval> | null = null;
  const stopStepPlay = (): void => {
    if (stepPlayTimer) clearInterval(stepPlayTimer);
    stepPlayTimer = null;
    const btn = document.getElementById('lego-step-play');
    if (btn) btn.textContent = '▶';
  };
  document.getElementById('lego-step-play')?.addEventListener('click', () => {
    const slider = document.getElementById('lego-step-slider') as HTMLInputElement | null;
    const btn = document.getElementById('lego-step-play');
    if (!slider || !btn) return;
    if (stepPlayTimer) { stopStepPlay(); return; }
    btn.textContent = '⏸';
    const max = parseInt(slider.max, 10);
    // If at max already, restart from step 1
    if (parseInt(slider.value, 10) >= max) {
      slider.value = '1';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
    stepPlayTimer = setInterval(() => {
      const cur = parseInt(slider.value, 10);
      if (cur >= max) { stopStepPlay(); return; }
      slider.value = String(cur + 1);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }, 350);
  });

  // ── Step slider ────────────────────────────────────────────────────────────
  // Stop playback when the user explicitly drags/clicks the thumb (not on the
  // programmatic dispatchEvent('input') from playback, which uses the input
  // event but not pointerdown).
  // Step ⟷ Layer mode toggle (3D mode only; updateStepSlider gates it)
  document.getElementById('lego-step-mode')?.addEventListener('click', () => {
    if (!directRenderMode || !currentLDrawViewer) return;
    stopStepPlay();
    sliderMode = sliderMode === 'step' ? 'layer' : 'step';
    updateStepSlider(); // re-applies mode to the viewer + resets slider to max
  });

  document.getElementById('lego-step-slider')?.addEventListener('pointerdown', stopStepPlay);
  document.getElementById('lego-step-slider')?.addEventListener('input', async e => {
    const slider = e.target as HTMLInputElement;
    const step = parseInt(slider.value, 10);
    const label = document.getElementById('lego-step-label');
    const sliderMax = parseInt(slider.max, 10) || totalSteps;
    if (label) label.textContent = `${step}/${sliderMax}`;
    if (!currentBricks) return;

    // 3D direct mode: instant visibility toggle on the persistent viewer.
    // No part refetch, no mesh rebuild — the architectural turn-around.
    if (directRenderMode && currentLDrawViewer) {
      // Only persist step-mode positions: currentStep feeds re-loads and the
      // voxelizer, both of which speak assembly steps, not layers.
      if (sliderMode === 'step') currentStep = step < totalSteps ? step : undefined;
      currentLDrawViewer.setMaxStep(step >= sliderMax ? Number.POSITIVE_INFINITY : step);
      return;
    }

    currentStep = step < totalSteps ? step : undefined; // undefined = show all

    // Voxelizer mode still rebuilds (cheap relative to part fetching anyway)
    const opts: VoxelizeOptions = { cubicScale, detailScale, maxStep: currentStep };
    const result = geometryMode
      ? await voxelizeLDrawGeometry(currentBricks, currentBricksColorFn, opts)
      : voxelizeLDraw(currentBricks, currentBricksColorFn, opts);
    if (onResult) onResult(result.grid, currentBricksLabel.replace(/\.[^.]+$/, ''), cubicScale);
  });

  // ── MPD file upload ────────────────────────────────────────────────────────
  const mpdInput = document.getElementById('lego-mpd-input') as HTMLInputElement;
  const uploadZone = document.getElementById('lego-upload-zone') as HTMLLabelElement;

  mpdInput.addEventListener('change', async () => {
    const file = mpdInput.files?.[0];
    if (!file) return;
    await parseMpdFile(file);
    mpdInput.value = '';
  });

  uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
  uploadZone.addEventListener('drop', async e => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    await parseMpdFile(file);
  });

  // ── Search ─────────────────────────────────────────────────────────────────
  const searchInput = document.getElementById('lego-search') as HTMLInputElement;
  const searchBtn   = document.getElementById('lego-search-btn') as HTMLButtonElement;

  const doSearch = async () => {
    const query    = searchInput.value.trim();
    const themeEl  = document.getElementById('lego-theme')    as HTMLSelectElement;
    const minYrEl  = document.getElementById('lego-year-min') as HTMLInputElement;
    const maxYrEl  = document.getElementById('lego-year-max') as HTMLInputElement;
    const themeId  = themeEl.value  ? parseInt(themeEl.value)  : null;
    const minYear  = minYrEl.value  ? parseInt(minYrEl.value)  : null;
    const maxYear  = maxYrEl.value  ? parseInt(maxYrEl.value)  : null;

    if (!query && themeId == null && minYear == null) {
      setStatus('Enter a set name, number, or choose a theme.', 'error');
      return;
    }

    searchBtn.disabled = true;

    try {
      if (!isLoaded()) {
        setStatus('Loading catalog…', 'info');
        await ensureCatalog(msg => setStatus(msg, 'info'));
      }

      searchResults = searchCatalog(query, themeId, minYear, maxYear);
      // Populate theme dropdown once loaded
      populateThemes(getThemes());

      // Clear any previously selected set when a new search runs
      selectedSet = null;
      const detailEl = document.getElementById('lego-detail');
      if (detailEl) detailEl.hidden = true;

      if (searchResults.length === 0) {
        setStatus('No sets found — try a different query.', 'info');
        hideResults();
      } else {
        setStatus(`${searchResults.length} set${searchResults.length !== 1 ? 's' : ''} found`, 'success');
        renderResults(searchResults);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`Search failed: ${msg}`, 'error');
    } finally {
      searchBtn.disabled = false;
    }
  };

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  // Populate themes once catalog finishes loading in background
  ensureCatalog().then(() => populateThemes(getThemes())).catch(() => {});
}

// ─── Results ─────────────────────────────────────────────────────────────────

function renderResults(sets: CatalogSet[]): void {
  const resultsEl = document.getElementById('lego-results')!;
  const gridEl    = document.getElementById('lego-results-grid')!;
  resultsEl.hidden = false;

  gridEl.innerHTML = sets.map((s, i) => {
    const inOmr = isInOmr(s.set_num);
    return `
    <button class="lego-result-card${inOmr ? ' lego-result-card-omr' : ''}" data-idx="${i}" title="${escAttr(s.name)}">
      <img class="lego-result-img" src="/lego-thumbs/${escAttr(s.set_num)}.jpg"
        data-cdn="${escAttr(s.img_url)}" alt="" loading="lazy" decoding="async"
        onerror="if(!this.dataset.tried){this.dataset.tried='1';this.src=this.dataset.cdn;}else{this.style.display='none';this.nextElementSibling.style.display='flex';}">
      <div class="lego-result-img-placeholder" style="display:none">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="7" width="20" height="14" rx="2"/>
          <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
        </svg>
      </div>
      ${inOmr ? '<div class="lego-omr-badge">3D</div>' : ''}
      <div class="lego-result-info">
        <div class="lego-result-num">${escAttr(s.set_num)}</div>
        <div class="lego-result-name">${escAttr(s.name)}</div>
        <div class="lego-result-meta">${s.year} · ${s.num_parts.toLocaleString()} pcs</div>
      </div>
    </button>
  `;
  }).join('');

  gridEl.querySelectorAll<HTMLButtonElement>('.lego-result-card').forEach(card => {
    card.addEventListener('click', () => selectSet(sets[parseInt(card.dataset['idx']!)]));
  });
}

function hideResults(): void {
  const el = document.getElementById('lego-results');
  if (el) el.hidden = true;
}

// ─── Set Selection ───────────────────────────────────────────────────────────

function selectSet(set: CatalogSet): void {
  selectedSet = set;

  document.querySelectorAll<HTMLElement>('.lego-result-card').forEach(c => {
    const idx = parseInt(c.dataset['idx'] ?? '-1', 10);
    c.classList.toggle('selected', idx >= 0 && searchResults[idx] === set);
  });

  const detailEl = document.getElementById('lego-detail')!;
  const innerEl  = document.getElementById('lego-detail-inner')!;
  const omrEl    = document.getElementById('lego-omr-links')!;
  detailEl.hidden = false;

  const setNumBase = set.set_num.replace(/-\d+$/, '');

  innerEl.innerHTML = `
    <div class="lego-detail-header">
      <img class="lego-detail-img" src="/lego-thumbs/${escAttr(set.set_num)}.jpg"
        data-cdn="${escAttr(set.img_url)}" alt=""
        onerror="if(!this.dataset.tried){this.dataset.tried='1';this.src=this.dataset.cdn;}else{this.style.display='none';}">
      <div class="lego-detail-meta">
        <div class="lego-detail-num">${escAttr(set.set_num)}</div>
        <div class="lego-detail-name">${escAttr(set.name)}</div>
        <div class="lego-detail-stats">
          <span>${set.year}</span>
          <span>${set.num_parts.toLocaleString()} pcs</span>
        </div>
        <a href="${escAttr(set.set_url)}" target="_blank" rel="noopener" class="lego-ext-link">
          Rebrickable ↗
        </a>
        <span id="lego-instr-links"></span>
      </div>
    </div>
    <button class="btn btn-primary lego-auto-load-btn" id="lego-auto-load">
      Auto-Load LDraw from OMR
    </button>
  `;

  // Wire auto-load button
  const autoBtn = document.getElementById('lego-auto-load') as HTMLButtonElement;
  autoBtn.addEventListener('click', () => autoLoadFromOMR(set));

  // Async: inject instruction PDF links when map is loaded
  getInstructionsMap().then(map => {
    const urls = map[setNumBase];
    const linksEl = document.getElementById('lego-instr-links');
    if (!urls || urls.length === 0 || !linksEl) return;
    linksEl.innerHTML = urls.map((url, i) =>
      `<a href="${escAttr(url)}" target="_blank" rel="noopener" class="lego-ext-link">
        Instructions${urls.length > 1 ? ` ${i + 1}` : ''} PDF ↗
      </a>`
    ).join('');
  });

  const omrFileUrl = `${OMR_BASE}/${encodeURIComponent(set.set_num)}.mpd`;
  omrEl.innerHTML = `
    <div class="lego-omr-row">
      <span class="lego-omr-label">Get LDraw file for <code>${escAttr(set.set_num)}</code>:</span>
    </div>
    <div class="lego-omr-row">
      <a href="${escAttr(omrFileUrl)}" target="_blank" rel="noopener" class="lego-ext-link">LDraw OMR ↗</a>
      <a href="https://www.bricklink.com/v3/studio/studio.page" target="_blank" rel="noopener" class="lego-ext-link">BrickLink Studio ↗</a>
    </div>
    <p class="lego-omr-note">
      Click Auto-Load to try automatic download · or open in BrickLink Studio and export <code>.ldr</code> → upload above
    </p>
  `;

  detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ─── OMR Auto-Load ───────────────────────────────────────────────────────────

/**
 * Try to auto-fetch an LDraw file from LDraw OMR (library.ldraw.org).
 */
async function autoLoadFromOMR(set: CatalogSet): Promise<void> {
  const btn = document.getElementById('lego-auto-load') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  // ── Source 1: LDraw OMR ──────────────────────────────────────────────────
  const inOmr = !isOmrLoaded() || isInOmr(set.set_num);
  if (inOmr) {
    const filename = `${set.set_num}.mpd`;
    const url = `${OMR_FETCH_BASE}/${encodeURIComponent(filename)}`;
    setStatus(`Trying LDraw OMR: ${filename}…`, 'info');
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const text = await resp.text();
        if (btn) btn.disabled = false;
        await parseMpdFile(new File([text], filename, { type: 'text/plain' }));
        return;
      }
      // 404 → not found
    } catch (err) {
      throw err;
    }
  }

  // ── Source 2: Clego reconstructed LDR (3D assembled model from PDF/IO) ──
  const reconIdx = await getReconstructedIndex();
  const baseNum = baseSetNum(set.set_num);
  if (reconIdx.has(baseNum)) {
    const filename = `${baseNum}_reconstructed.ldr`;
    setStatus(`Trying reconstructed 3D model: ${filename}…`, 'info');
    try {
      const resp = await fetch(`${RECONSTRUCTED_BASE}/${filename}`);
      if (resp.ok) {
        const text = await resp.text();
        const quality = reconstructionQuality(text);
        if (quality === 'broken') {
          // DBIX_LXFML-sourced conversions were written without per-part
          // LDD→LDraw origin alignment — parts render scattered/mis-rotated
          // and colors are raw material ids (10320 et al. are a jumble).
          // A flat BFF inventory beats a jumble; fall through.
          console.warn(`[lego] skipping ${filename}: DBIX_LXFML conversion lacks part alignment (would render scrambled)`);
        } else {
          currentMpdContent = text;
          currentCustomParts = undefined;
          const bricks = parseLDraw(text);
          if (bricks.length > 0) {
            if (btn) btn.disabled = false;
            const warn = quality === 'approximate'
              ? ' ⚠ vision-based reconstruction — placements are approximate'
              : '';
            setStatus(`Loaded reconstructed 3D model for ${set.set_num} (${bricks.length} parts)${warn}`, 'info');
            await voxelizeAndDisplay(bricks, set.set_num);
            return;
          }
        }
      }
    } catch { /* fall through */ }
  }

  // ── Source 3: BrickLink BFF inventory (flat colour layout — last resort) ─
  setStatus(`No 3D model found — trying BL parts inventory for ${set.set_num}…`, 'info');
  try {
    const parts = await fetchBffInventory(set.set_num);
    if (parts.length > 0) {
      const ldrText = bffInventoryToLDraw(set.set_num, parts);
      currentMpdContent = ldrText;
      currentCustomParts = undefined;
      const bricks = parseLDraw(ldrText);
      if (bricks.length > 0) {
        setStatus(
          `⚠ 2D colour map only — no 3D model available (${parts.length} part types from BL inventory)`,
          'info',
        );
        if (btn) btn.disabled = false;
        await voxelizeAndDisplay(bricks, set.set_num, studioColorToBlock);
        return;
      }
    }
  } catch {
    // BFF unavailable — fall through to manual instructions
  }

  // ── Not found ────────────────────────────────────────────────────────────
  const omrManual = `${OMR_BASE}/${encodeURIComponent(set.set_num)}.mpd`;
  setStatus(
    `No 3D model found for ${set.set_num}. Try BrickLink Studio → export LDraw → upload above.`,
    'info',
  );
  const omrEl = document.getElementById('lego-omr-links');
  if (omrEl) {
    omrEl.innerHTML = `
      <div class="lego-omr-row">
        <span class="lego-omr-label">Manual download for <code>${escAttr(set.set_num)}</code>:</span>
      </div>
      <div class="lego-omr-row">
        <a href="${escAttr(omrManual)}" target="_blank" rel="noopener" class="lego-ext-link">
          LDraw OMR ↗
        </a>
        <a href="https://www.bricklink.com/v3/studio/studio.page" target="_blank" rel="noopener" class="lego-ext-link">
          BrickLink Studio ↗
        </a>
      </div>
      <p class="lego-omr-note">Download the <code>.mpd</code> or <code>.ldr</code> file, then drag it into the upload zone above.</p>
    `;
  }
  if (btn) btn.disabled = false;
}

// ─── Export loaded set (3D model / Minecraft schematic) ──────────────────────

/** Lazily fetch + cache the LDraw color-id → name map (for the BOM CSV). */
let colorNamesPromise: Promise<Record<string, string>> | null = null;
function loadColorNames(): Promise<Record<string, string>> {
  if (!colorNamesPromise) {
    colorNamesPromise = fetch('/ldraw-color-names.json')
      .then(r => (r.ok ? r.json() : {}))
      .catch(() => ({} as Record<string, string>));
  }
  return colorNamesPromise;
}

async function exportLoadedModel(fmt: string): Promise<void> {
  if (!currentBricks) { setStatus('Load a set first, then export.', 'error'); return; }
  const base = (currentBricksLabel || 'model').replace(/\.[^.]+$/, '') || 'model';
  try {
    if (fmt === 'glb' || fmt === 'obj' || fmt === 'stl') {
      if (!currentLDrawViewer) {
        setStatus('3D export needs the 3D renderer (enable “3D Render”).', 'error');
        return;
      }
      const meshes = currentLDrawViewer.exportMeshes();
      if (meshes.length === 0) { setStatus('No geometry to export.', 'error'); return; }
      // exporter.ts bakes one Mesh per instance (no instancing in OBJ/STL), so
      // file size scales with triangles. OBJ ≈ 320 B/tri, STL = 50 B/tri.
      // GLB stays compact (glTF reuses shared accessors). Guard the un-instanced
      // formats so a huge set can't OOM the browser building a multi-GB
      // string/buffer — steer the user to GLB instead.
      const tris = countExportTriangles(meshes as unknown as Parameters<typeof countExportTriangles>[0]);
      const OBJ_MAX_TRIS = 2_000_000; // ~640 MB OBJ
      const STL_MAX_TRIS = 12_000_000; // ~600 MB STL
      if (fmt === 'obj' && tris > OBJ_MAX_TRIS) {
        setStatus(`Too large for OBJ (${(tris / 1e6).toFixed(1)}M triangles → ~${Math.round(tris * 320 / 1e6)} MB). Use GLB — it stays compact via shared geometry.`, 'error');
        return;
      }
      if (fmt === 'stl' && tris > STL_MAX_TRIS) {
        setStatus(`Too large for STL (${(tris / 1e6).toFixed(1)}M triangles → ~${Math.round(tris * 50 / 1e6)} MB). Use GLB, or slice the model with the layer/step slider first.`, 'error');
        return;
      }
      const big = (fmt === 'obj' || fmt === 'stl') && tris > 1_000_000;
      setStatus(big ? `Baking ${(tris / 1e6).toFixed(1)}M triangles to ${fmt.toUpperCase()} — large file, please wait…` : `Exporting ${fmt.toUpperCase()}…`, 'info');
      await new Promise(r => setTimeout(r, 0)); // paint the status before the (heavy, sync) bake
      // Only viewer.meshes is read by the exporters — duck-type a ViewerState.
      const shim = { meshes } as unknown as ViewerState;
      if (fmt === 'glb') { await exportGLB(shim, `${base}.glb`); setStatus(`Exported ${base}.glb`, 'success'); }
      else {
        // STL/OBJ bake at real-LEGO scale (8 mm/stud) so prints come out true size.
        const sz = currentLDrawViewer.getModelSizeStuds();
        const mm = sz ? ` at real scale ${Math.round(sz.x * 8)}×${Math.round(sz.z * 8)}×${Math.round(sz.y * 8)} mm` : '';
        if (fmt === 'obj') await exportOBJ(shim, `${base}.obj`);
        else await exportSTL(shim, `${base}.stl`);
        setStatus(`Exported ${base}.${fmt}${mm}`, 'success');
      }
      return;
    }

    if (fmt === 'schem' || fmt === 'litematic') {
      setStatus('Voxelizing for Minecraft…', 'info');
      // Yield a frame so the status paints before the (sync) voxelize.
      await new Promise(r => setTimeout(r, 0));
      const opts: VoxelizeOptions = { cubicScale, detailScale };
      const { grid } = voxelizeLDraw(currentBricks, currentBricksColorFn, opts);
      if (fmt === 'schem') exportSchem(grid, `${base}.schem`);
      else exportLitematic(grid, `${base}.litematic`);
      const blocks = grid.countNonAir();
      setStatus(`Exported ${base}.${fmt} (${blocks.toLocaleString()} blocks, ${grid.width}×${grid.height}×${grid.length})`, 'success');
      return;
    }

    if (fmt === 'csv') {
      // Bill of materials: count each (part, color) and emit CSV.
      const counts = new Map<string, { part: string; color: number; count: number }>();
      for (const b of currentBricks) {
        const part = b.part.replace(/\.dat$/i, '');
        const color = Number.isNaN(b.color) ? 16 : b.color;
        const key = `${part}|${color}`;
        const e = counts.get(key) ?? { part, color, count: 0 };
        e.count++;
        counts.set(key, e);
      }
      const rows = [...counts.values()].sort((a, b) => b.count - a.count || a.part.localeCompare(b.part));
      const colorNames = await loadColorNames();
      const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
      const lines = ['Part,ColorID,ColorName,ColorHex,Count'];
      for (const r of rows) {
        const name = colorNames[String(r.color)] ?? '';
        lines.push(`${esc(r.part)},${r.color},${esc(name)},${LDRAW_COLOR_RGB[r.color] ?? ''},${r.count}`);
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${base}-parts.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 100);
      setStatus(`Exported parts list: ${rows.length} unique part/colors, ${currentBricks.length} bricks`, 'success');
      return;
    }
  } catch (err) {
    setStatus(`Export failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

// ─── Parse + Voxelize ────────────────────────────────────────────────────────

/**
 * Classify a clego-reconstructed LDR by its header provenance comments.
 * - 'good': assembled from an already-LDraw source (model2.ldr) — faithful.
 * - 'approximate': vision-reconstructed from instruction pages — placements
 *   are heuristic (floaters/mis-orientations are in the DATA).
 * - 'broken': converted from DBIX LXFML without per-part LDD→LDraw origin
 *   alignment — renders scrambled; colors are raw material ids.
 */
function reconstructionQuality(ldrText: string): 'good' | 'approximate' | 'broken' {
  const head = ldrText.slice(0, 600);
  if (/Source:\s*DBIX_LXFML/i.test(head)) return 'broken';
  if (/inverse isometric projection|blob (fallback|detection)/i.test(head)) return 'approximate';
  return 'good';
}

async function parseMpdFile(file: File): Promise<void> {
  if (!onResult) return;
  setStatus(`Parsing ${file.name}…`, 'info');

  try {
    const ext = file.name.split('.').pop()?.toLowerCase();

    if (ext === 'lxf') {
      const buf = await file.arrayBuffer();
      const bricks = await parseLxf(buf);
      await voxelizeAndDisplay(bricks, file.name);
      return;
    }

    let text: string;
    if (ext === 'io') {
      const buf = await file.arrayBuffer();
      const ioModel = await extractIoModel(buf);
      text = ioModel.text;
      currentMpdContent = text;
      currentCustomParts = ioModel.customParts.size ? ioModel.customParts : undefined;
      const bricks = parseLDraw(text);
      if (bricks.length === 0) throw new Error('No brick placements found in file.');
      await voxelizeAndDisplay(bricks, file.name, studioColorToBlock);
      return;
    }

    text = await file.text();
    currentMpdContent = text; // store for 3D renderer inline sub-model resolution
    currentCustomParts = undefined;
    const bricks = parseLDraw(text);
    if (bricks.length === 0) throw new Error('No brick placements found in file.');
    // User explicitly chose this file — load it, but set expectations if it's
    // a known-imperfect reconstruction (the defects are in the data).
    const q = reconstructionQuality(text);
    if (q === 'broken') {
      setStatus('⚠ This file is a DBIX/LXFML conversion without part alignment — parts will render scattered/mis-rotated and colors may be wrong. The defects are in the file, not the renderer.', 'info');
    } else if (q === 'approximate') {
      setStatus('⚠ Vision-based reconstruction — part placements are approximate.', 'info');
    }
    await voxelizeAndDisplay(bricks, file.name);
  } catch (err) {
    setStatus(`Parse failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

function updateScaleControlsVisibility(): void {
  // Scale buttons (Accurate/Cubic/Detail) and the Geometry checkbox only affect
  // the voxelizer pipeline. In direct 3D render mode they have no effect, so
  // hide them to avoid the appearance of broken controls.
  const btns = document.getElementById('lego-scale-btns');
  const geomLabel = document.getElementById('lego-geometry-mode')?.parentElement as HTMLElement | null;
  const scaleLabel = btns?.previousElementSibling as HTMLElement | null;
  if (btns) btns.style.display = directRenderMode ? 'none' : '';
  if (geomLabel) geomLabel.style.display = directRenderMode ? 'none' : '';
  if (scaleLabel && scaleLabel.classList.contains('lego-section-label')) {
    scaleLabel.style.display = directRenderMode ? 'none' : '';
  }
}

function updateStepSlider(): void {
  const row = document.getElementById('lego-step-row');
  const slider = document.getElementById('lego-step-slider') as HTMLInputElement | null;
  const label = document.getElementById('lego-step-label');
  const modeBtn = document.getElementById('lego-step-mode') as HTMLButtonElement | null;
  if (!row || !slider || !label) return;

  // Layer count comes from the 3D viewer (quantized plate heights) — only
  // known once a model is loaded there. Voxel mode sticks to steps.
  const is3d = directRenderMode && !!currentLDrawViewer;
  const layers = is3d ? currentLDrawViewer!.getMaxAvailableLayer() : 1;
  const steps = totalSteps;

  // Pick/repair the slider mode: layer mode needs the 3D viewer; default to
  // layers when the model has no usable STEP markers (most .io exports).
  if (!is3d) sliderMode = 'step';
  else if (steps <= 1 && layers > 1) sliderMode = 'layer';
  else if (layers <= 1) sliderMode = 'step';
  if (is3d) currentLDrawViewer!.setSliderMode(sliderMode);

  const hasAny = is3d ? steps > 1 || layers > 1 : steps > 1;
  const max = Math.max(1, sliderMode === 'layer' ? layers : steps);
  // NOTE: `.lego-scale-row` sets `display:flex`, which overrides the `hidden`
  // attribute (inline/UA precedence) — so we MUST toggle style.display, not
  // just .hidden, or the row stays visible. Also ALWAYS reset the slider
  // values (even when hiding) so a stale count from a previous multi-step
  // model can't persist into a no-step model.
  slider.max = String(max);
  slider.value = String(max);
  label.textContent = `${max}/${max}`;
  if (modeBtn) {
    modeBtn.textContent = sliderMode === 'layer' ? 'Layer' : 'Step';
    // The button doubles as the row label; it's a working toggle only when
    // both keys are meaningful.
    const toggleable = is3d && steps > 1 && layers > 1;
    modeBtn.disabled = !toggleable;
    modeBtn.style.cursor = toggleable ? 'pointer' : 'default';
    modeBtn.style.opacity = toggleable ? '1' : '0.7';
  }
  row.hidden = !hasAny;
  row.style.display = hasAny ? '' : 'none';
}

async function voxelizeAndDisplay(
  bricks: ParsedBrick[],
  filename: string,
  colorFn?: (id: number) => string,
): Promise<void> {
  if (!onResult) return;

  // Only reset the slider when a *new* model is loaded — not when the user
  // drags the slider, since the slider handler re-enters this function and
  // would otherwise snap the value back to totalSteps every input event.
  const isNewModel = bricks !== currentBricks;
  currentBricks = bricks;
  currentBricksLabel = filename;
  currentBricksColorFn = colorFn;
  if (isNewModel) {
    totalSteps = countSteps(bricks);
    currentStep = undefined;
    // Fresh model → fresh slider key: real assembly steps beat synthetic
    // layers when the file has them (updateStepSlider falls back to layers
    // for step-less models once the 3D viewer reports its layer count).
    sliderMode = 'step';
    updateStepSlider();
  }

  // ── Direct 3D Render mode: render LDraw triangles as meshes, skip voxelization ──
  if (directRenderMode) {
    const label = selectedSet
      ? `${selectedSet.set_num} ${selectedSet.name}`
      : filename.replace(/\.[^.]+$/, '');
    setStatus(`Rendering ${label} — ${bricks.length} bricks (loading geometry…)`, 'info');
    try {
      const { LDrawViewer } = await import('@viewer/ldraw/index.js');
      const viewerEl = rootEl.closest('.tab-content')?.querySelector('.viewer-area, .inline-viewer') as HTMLElement
        ?? document.getElementById('lego-viewer');
      if (viewerEl) {
        // Persistent viewer: create once, call load() per model. If the
        // viewer is mounted on the same element, keep it alive across
        // model changes — load() clears prior meshes but reuses the
        // renderer/scene/composer/part-cache.
        if (currentLDrawViewer && currentLDrawViewer.container !== viewerEl) {
          currentLDrawViewer.dispose();
          currentLDrawViewer = null;
        }
        if (!currentLDrawViewer) {
          viewerEl.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;gap:12px">
            <div style="width:40px;height:40px;border:3px solid rgba(255,255,255,0.2);border-top-color:#7c3aed;border-radius:50%;animation:spin 0.8s linear infinite"></div>
            <span style="color:#999;font-size:13px">Loading geometry…</span>
            <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
          </div>`;
          currentLDrawViewer = await LDrawViewer.create(viewerEl);
          currentLDrawViewer.onBrickHover = (brick, x, y) => {
            const tip = document.getElementById('lego-hover-tooltip');
            if (!tip) return;
            if (!brick) { tip.hidden = true; return; }
            const partName = brick.part.replace(/\.dat$/i, '');
            tip.textContent = `${partName} · color ${brick.color}`;
            // Position 12px down-right of cursor, clamp to viewport
            const tipW = tip.offsetWidth || 100;
            const tipH = tip.offsetHeight || 20;
            const px = Math.min(x + 12, window.innerWidth - tipW - 4);
            const py = Math.min(y + 12, window.innerHeight - tipH - 4);
            tip.style.left = `${px}px`;
            tip.style.top = `${py}px`;
            tip.hidden = false;
          };
          currentLDrawViewer.onBrickClick = async brick => {
            const el = document.getElementById('lego-picked-brick');
            if (!el) return;
            const { LDRAW_COLOR_RGB } = await import('@engine/ldraw-colors.js');
            const colorHex = LDRAW_COLOR_RGB[brick.color] ?? '#808080';
            const partName = brick.part.replace(/\.dat$/i, '');
            el.replaceChildren();
            const swatch = document.createElement('span');
            swatch.style.cssText = `display:inline-block;width:10px;height:10px;background:${colorHex};border:1px solid rgba(255,255,255,0.3);border-radius:2px;margin-right:6px;vertical-align:middle`;
            const colorRow = document.createElement('div');
            colorRow.appendChild(swatch);
            colorRow.append(`Color id ${brick.color} (${colorHex})`);
            const lines = [
              `Part: ${partName}`,
            ];
            for (const line of lines) {
              const div = document.createElement('div');
              div.textContent = line;
              el.appendChild(div);
            }
            el.appendChild(colorRow);
            const posDiv = document.createElement('div');
            posDiv.textContent = `Pos: ${brick.x.toFixed(1)}, ${brick.y.toFixed(1)}, ${brick.z.toFixed(1)}`;
            el.appendChild(posDiv);
            if (brick.step != null) {
              const stepDiv = document.createElement('div');
              stepDiv.textContent = `Step: ${brick.step}`;
              el.appendChild(stepDiv);
            }
            el.hidden = false;
          };
        }
        let lastProgressUpdate = 0;
        showProgress(0);
        await currentLDrawViewer.load(bricks, {
          mpdContent: currentMpdContent,
          datFiles: currentCustomParts,
          maxStep: currentStep,
          onProgress: (done, total) => {
            const pct = total > 0 ? done / total : 0;
            showProgress(pct);
            const now = Date.now();
            if (now - lastProgressUpdate > 200 || done === total) {
              setStatus(`Loading geometry: ${done}/${total} parts (${Math.round(pct * 100)}%)…`, 'info');
              lastProgressUpdate = now;
            }
          },
        });
        hideProgress();
        // Surface any pieces that couldn't be rendered (missing from the
        // bundled part library, or LSynth flexible parts needing synthesis)
        // so missing geometry is never silent.
        // Physical size: scene units == studs (1 stud = 0.8 cm). Footprint in
        // studs + overall L×W×H in cm — what builders/display-planners want.
        const sz = currentLDrawViewer.getModelSizeStuds();
        let dims = '';
        if (sz) {
          const studs = (n: number) => Math.round(n);
          const cm = (n: number) => (n * 0.8).toFixed(1);
          dims = ` · ≈ ${studs(sz.x)}×${studs(sz.z)} studs (${cm(sz.x)}×${cm(sz.z)}×${cm(sz.y)} cm)`;
        }
        // The viewer now knows the model's vertical layer count — refresh the
        // slider so layer mode becomes available (it's the default for
        // models without STEP markers, i.e. most Studio .io exports).
        updateStepSlider();
        // Completeness check: a fan-made model file can contain fewer pieces
        // than the official set (e.g. one 21063 .io ships 3,245 of 3,455 —
        // its autumn trees were never modelled). Say so, or users read the
        // gap as a rendering bug.
        let completeness = '';
        {
          const setNum = selectedSet?.set_num
            ?? (filename.match(/\b(\d{4,7})(?:-\d)?\b/)?.[1]);
          if (setNum && isLoaded()) {
            const cat = searchCatalog(setNum, null, null, null, 1)[0];
            if (cat?.num_parts && cat.num_parts > 0) {
              const diff = cat.num_parts - bricks.length;
              if (diff > Math.max(20, cat.num_parts * 0.02)) {
                completeness = ` · file contains ${bricks.length.toLocaleString()} of the set's ${cat.num_parts.toLocaleString()} catalog pieces (incomplete source model)`;
              }
            }
          }
        }
        const missing = currentLDrawViewer.missingParts;
        const subGaps = currentLDrawViewer.unresolvedSubparts.length;
        const subGapNote = subGaps > 0 ? ` (${subGaps} sub-part file(s) unresolved — minor gaps, see console)` : '';
        if (missing.length > 0) {
          const totalMissing = missing.reduce((s, m) => s + m.count, 0);
          const names = missing.slice(0, 6).map(m => m.part.replace(/\.dat$/i, '')).join(', ');
          const more = missing.length > 6 ? ` +${missing.length - 6} more` : '';
          setStatus(
            `${label} — ${bricks.length} bricks rendered${dims}${completeness}. ⚠ ${totalMissing} piece(s) of ${missing.length} part type(s) not in library: ${names}${more}${subGapNote}`,
            'info',
          );
          console.warn('[lego] unrendered parts (missing from /ldraw-parts or LSynth):', missing);
        } else {
          setStatus(`${label} — ${bricks.length} bricks rendered as 3D geometry${dims}${completeness}${subGapNote}`, subGaps > 0 || completeness ? 'info' : 'success');
        }
        viewerEl.closest('.panel-layout')?.setAttribute('data-has-model', '');
        const explodeRow = document.getElementById('lego-explode-row');
        if (explodeRow) { explodeRow.hidden = false; explodeRow.style.display = ''; }
        // Reset explode slider to 0 on new model load so the freshly-rendered
        // model is in its assembled state.
        const exSlider = document.getElementById('lego-explode-slider') as HTMLInputElement | null;
        const exLabel = document.getElementById('lego-explode-label');
        if (exSlider) exSlider.value = '0';
        if (exLabel) exLabel.textContent = '0%';
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`3D render failed: ${msg}`, 'error');
      console.error('[ldraw-renderer]', e);
    }
    return;
  }

  // Voxelizer path is about to mount its own canvas in the same viewer
  // container. Dispose the 3D LDraw viewer first so the renderer.domElement
  // doesn't get orphaned (its render loop's container.isConnected check
  // would silently stop, leaving a dead canvas behind on next 3D toggle).
  if (currentLDrawViewer) {
    currentLDrawViewer.dispose();
    currentLDrawViewer = null;
  }

  const opts: VoxelizeOptions = { cubicScale, detailScale, maxStep: currentStep };
  if (geometryMode) setStatus('Loading triangle geometry…', 'info');
  const result = geometryMode
    ? await voxelizeLDrawGeometry(bricks, colorFn, opts)
    : voxelizeLDraw(bricks, colorFn, opts);

  const { width: w, height: h, length: l } = result.grid;
  const blockCount = result.grid.countNonAir();
  const label = selectedSet
    ? `${selectedSet.set_num} ${selectedSet.name}`
    : filename.replace(/\.[^.]+$/, '');

  // Build status + warnings
  const warnings: string[] = [];
  if (result.warning) warnings.push(result.warning);
  if (result.wasFlipped) warnings.push('Model Y-axis was auto-flipped (upside-down source file)');
  if (result.unmappedColors.length > 0) {
    const ids = result.unmappedColors.slice(0, 5).join(', ');
    const more = result.unmappedColors.length > 5 ? ` +${result.unmappedColors.length - 5} more` : '';
    warnings.push(`${result.unmappedColors.length} unmapped color IDs (${ids}${more}) → gray`);
  }
  if (!cubicScale && h > 384) {
    warnings.push(`Height ${h} exceeds render limit (384) — try Cubic scale`);
  }
  if (Math.max(w, h, l) > 300 && !cubicScale) {
    warnings.push(`Large model (${w}×${h}×${l}) — Cubic scale reduces proportionally`);
  }
  if (result.fallbackPartCount > 0) {
    warnings.push(`${result.fallbackPartCount} parts had unknown dims (fell back to 1×1×1)`);
  }

  // Post-processing differs by mode:
  // AABB mode: fill hollows + gaps (bounding boxes leave interior voids)
  // Geometry mode: remove debris + light gap-fill (ray casting is mostly accurate but
  // non-watertight meshes leave 1-cell holes in surfaces)
  if (geometryMode) {
    keepLargestComponent(result.grid);
    fillSingleVoxelGaps(result.grid); // close 1-2 cell surface holes from mesh gaps
  } else {
    solidifyColumns(result.grid, 6);
    fillSingleVoxelGaps(result.grid);
  }

  const statusMsg = `Built ${label}: ${w}×${h}×${l} — ${blockCount.toLocaleString()} blocks` +
    (cubicScale ? ' (cubic)' : '');
  // Render warnings as separate lines under the main status so the panel
  // doesn't wrap a single long ⚠-prefixed paragraph mid-word.
  setStatusWithWarnings(statusMsg, warnings, warnings.length ? 'info' : 'success');

  onResult(result.grid, label, cubicScale);
}

// ─── Theme Dropdown ──────────────────────────────────────────────────────────

function populateThemes(themes: CatalogTheme[]): void {
  const select = document.getElementById('lego-theme') as HTMLSelectElement | null;
  if (!select || select.options.length > 1) return; // already populated
  const topLevel = themes.filter(t => t.parent_id == null);
  select.innerHTML = `<option value="">All Themes</option>` +
    topLevel.map(t => `<option value="${t.id}">${escAttr(t.name)}</option>`).join('');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setStatus(msg: string, type: 'info' | 'error' | 'success'): void {
  const el = document.getElementById('lego-status');
  if (!el) return;
  el.textContent = msg;
  el.className = `lego-status lego-status-${type}`;
  el.hidden = !msg;
}

function showProgress(fraction: number): void {
  const bar = document.getElementById('lego-progress');
  const fill = document.getElementById('lego-progress-fill');
  if (!bar || !fill) return;
  bar.hidden = false;
  fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
}

function hideProgress(): void {
  const bar = document.getElementById('lego-progress');
  if (bar) bar.hidden = true;
}

/**
 * Like setStatus but renders warnings on their own lines under the main
 * message so they don't wrap mid-word in the narrow side panel.
 */
function setStatusWithWarnings(
  msg: string,
  warnings: readonly string[],
  type: 'info' | 'error' | 'success',
): void {
  const el = document.getElementById('lego-status');
  if (!el) return;
  el.replaceChildren();
  const main = document.createElement('div');
  main.textContent = msg;
  el.appendChild(main);
  for (const w of warnings) {
    const line = document.createElement('div');
    line.textContent = `⚠ ${w}`;
    line.style.cssText = 'margin-top:4px;font-size:0.92em;opacity:0.85';
    el.appendChild(line);
  }
  el.className = `lego-status lego-status-${type}`;
  el.hidden = false;
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
