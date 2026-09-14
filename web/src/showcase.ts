/**
 * Craftmatic LEGO Showcase — single-page interactive 3D viewer.
 *
 * Fetches LDraw MPD from OMR, voxelizes it, and renders it in full-screen
 * Three.js with OrbitControls (zoom / pan / orbit).
 */

import { createLegoViewer, ACCURATE_Y_SCALE, type ViewerState } from '@viewer/lego-scene.js';
import { parseLDraw } from '@engine/ldraw-parser.js';
import { voxelizeLDraw } from '@engine/ldraw-voxelizer.js';

// ─── Model catalogue ──────────────────────────────────────────────────────────

interface ShowcaseModel {
  id: string;
  name: string;
  year: number;
  pieces: number;
  score: number;      // visual quality score from grader
  theme: string;
}

const MODELS: ShowcaseModel[] = [
  { id: '10030-1', name: 'Imperial Star Destroyer', year: 2002, pieces: 3104, score: 9, theme: 'Star Wars' },
  { id: '8855-1',  name: 'Prop Plane',              year: 1989, pieces: 465,  score: 9, theme: 'Technic' },
  { id: '42049-1', name: 'Mine Loader',              year: 2016, pieces: 212,  score: 9, theme: 'Technic' },
  { id: '60067-1', name: 'Helicopter Pursuit',       year: 2014, pieces: 355,  score: 9, theme: 'City' },
  { id: '6545-1',  name: 'Search N\' Rescue',        year: 1993, pieces: 183,  score: 9, theme: 'Town' },
  { id: '1472-1',  name: 'Holiday Home',             year: 1987, pieces: 363,  score: 7, theme: 'Town' },
];

// ─── State ────────────────────────────────────────────────────────────────────

let activeViewer: ViewerState | null = null;
let currentIndex = 0;
let cubicScale = true; // default: cubic mode → correct proportions (no 2.5× vertical stretch)
let isLoading = false;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const viewerRoot    = document.getElementById('viewer-root')!;
const loadingEl     = document.getElementById('loading-overlay')!;
const loadingName   = document.getElementById('loading-model-name')!;
const loadingLabel  = document.getElementById('loading-label')!;
const modelTitle    = document.getElementById('model-title')!;
const metaSet       = document.getElementById('meta-set')!;
const metaYear      = document.getElementById('meta-year')!;
const metaPieces    = document.getElementById('meta-pieces')!;
const statBlocks    = document.getElementById('stat-blocks')!;
const statDims      = document.getElementById('stat-dims')!;
const statScore     = document.getElementById('stat-score')!;
const modelPicker   = document.getElementById('model-picker')!;
const errorBanner   = document.getElementById('error-banner') as HTMLDivElement;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function showError(msg: string) {
  errorBanner.textContent = msg;
  errorBanner.style.display = 'block';
  setTimeout(() => { errorBanner.style.display = 'none'; }, 5000);
}

function setLoading(modelName: string, phase: string) {
  loadingEl.classList.remove('fade-out', 'hidden');
  loadingName.textContent = modelName;
  loadingLabel.textContent = phase;
}

function hideLoading() {
  loadingEl.classList.add('fade-out');
  setTimeout(() => loadingEl.classList.add('hidden'), 450);
}

function updateInfo(model: ShowcaseModel, blockCount: number, w: number, h: number, l: number) {
  modelTitle.textContent = model.name;
  metaSet.textContent = `Set ${model.id}`;
  metaYear.textContent = String(model.year);
  metaPieces.textContent = `${model.pieces.toLocaleString()} pieces`;
  statBlocks.textContent = fmt(blockCount);
  statDims.textContent = `${w}×${h}×${l}`;
  statScore.textContent = `${model.score}/10`;
}

// ─── Model picker UI ─────────────────────────────────────────────────────────

function buildPicker() {
  modelPicker.innerHTML = '';
  MODELS.forEach((m, i) => {
    const btn = document.createElement('button');
    btn.className = 'model-btn' + (i === currentIndex ? ' active' : '');
    btn.textContent = m.name.split(' ').slice(0, 2).join(' ');  // shorten for space
    btn.title = `${m.name} (${m.id}) — ${m.theme} ${m.year}`;
    btn.addEventListener('click', () => {
      if (i !== currentIndex && !isLoading) loadModel(i);
    });
    modelPicker.appendChild(btn);
  });
}

function updatePickerActive() {
  modelPicker.querySelectorAll<HTMLButtonElement>('.model-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === currentIndex);
  });
}

// ─── Scale toggle ─────────────────────────────────────────────────────────────

document.querySelectorAll<HTMLButtonElement>('.scale-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const newCubic = btn.dataset['scale'] === 'cubic';
    if (newCubic === cubicScale || isLoading) return;
    cubicScale = newCubic;
    document.querySelectorAll<HTMLButtonElement>('.scale-btn').forEach(b => {
      b.classList.toggle('active', b.dataset['scale'] === (cubicScale ? 'cubic' : 'accurate'));
    });
    loadModel(currentIndex);
  });
});

// ─── Core loader ─────────────────────────────────────────────────────────────

async function loadModel(index: number) {
  if (isLoading) return;
  isLoading = true;
  currentIndex = index;
  const model = MODELS[index];

  updatePickerActive();
  setLoading(model.name, 'Fetching LDraw model…');

  try {
    // 1. Fetch MPD from OMR proxy
    const resp = await fetch(`/ldraw-omr/${model.id}.mpd`);
    if (!resp.ok) throw new Error(`OMR fetch failed: ${resp.status}`);
    const text = await resp.text();

    setLoading(model.name, 'Parsing bricks…');
    // Use microtask gap so the label update paints
    await new Promise(r => setTimeout(r, 16));

    // 2. Parse
    const bricks = parseLDraw(text);

    setLoading(model.name, 'Voxelizing…');
    await new Promise(r => setTimeout(r, 16));

    // 3. Voxelize
    const result = voxelizeLDraw(bricks, undefined, { cubicScale });
    const { grid } = result;
    const { w, h, l } = result.dimensions;

    setLoading(model.name, 'Building scene…');
    await new Promise(r => setTimeout(r, 16));

    // 4. Dispose old viewer, create new one
    if (activeViewer) {
      activeViewer.dispose();
      viewerRoot.innerHTML = '';
    }
    const yScale = cubicScale ? 1.0 : ACCURATE_Y_SCALE;
    activeViewer = createLegoViewer(viewerRoot, grid, { yScale });

    // 5. Update info bar
    updateInfo(model, grid.countNonAir(), w, h, l);

    hideLoading();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showError(`Failed to load ${model.name}: ${msg}`);
    setLoading(model.name, `Error: ${msg}`);
  } finally {
    isLoading = false;
  }
}

// ─── Keyboard navigation ──────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (isLoading) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    loadModel((currentIndex + 1) % MODELS.length);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    loadModel((currentIndex - 1 + MODELS.length) % MODELS.length);
  } else if (e.key >= '1' && e.key <= '6') {
    const i = parseInt(e.key) - 1;
    if (i < MODELS.length) loadModel(i);
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

buildPicker();
loadModel(0);
