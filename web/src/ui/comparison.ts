/**
 * Comparison — 4-tier API data comparison viewer with triple-handle image slider.
 *
 * Shows addresses with 4 tiers each: No API / Basic APIs / All APIs / All + Environmental.
 * The triple slider lets users compare all 4 tiers simultaneously.
 * Also loads comparison-data.json (if available) for detailed per-API data cards.
 * Each tier has "Generate 3D" and "Download .schem" buttons.
 */

import type { StyleName, GenerationOptions } from '@craft/types/index.js';
import { generateStructure } from '@craft/gen/generator.js';
import { BlockGrid } from '@craft/schem/types.js';
import { exportSchem } from '@viewer/exporter.js';

// ─── Types (match comparison-data.json schema) ─────────────────────────────

interface ApiRecord {
  name: string;
  available: boolean;
  status: 'ok' | 'error' | 'skipped' | 'unavailable';
  error?: string;
  data: Record<string, unknown>;
  fieldsSet: string[];
  impactedGenFields: string[];
}

// ComparisonJsonEntry is used for all JSON data storage (see below)

// ─── Location data — loaded dynamically from comparison-data.json ───────────

interface TierData {
  style: string;
  floors: number;
  grid: string;
  blocks: string;
  sqft: string;
  beds: number | string;
  baths: number | string;
  year: string | number;
  sources: string;
  notes: string;
}

interface LocationViews {
  exterior: { noapi: string; someapis: string; allapis: string; enriched: string };
  cutaway: { noapi: string[]; someapis: string[]; allapis: string[]; enriched: string[] };
  floor: { noapi: string[]; someapis: string[]; allapis: string[]; enriched: string[] };
}

interface LocationEntry {
  label: string;
  address: string;
  noapi: TierData;
  someapis: TierData;
  allapis: TierData;
  enriched: TierData;
  views: LocationViews;
}

/** JSON schema from gen-comparison.ts */
interface TierJsonEntry {
  tier: string;
  property: Record<string, unknown>;
  genOptions: Record<string, unknown>;
  grid: { width: number; height: number; depth: number; blocks: number };
  views: { exterior: string; cutaway: string[]; floor: string[] };
}

/** Optional 3D Tiles voxelization data for comparing against procedural output */
interface TilesInfo {
  grid: { width: number; height: number; depth: number; blocks: number };
  paletteSize: number;
  resolution: number;     // blocks per meter
  radiusMeters: number;   // capture radius used
}

interface ComparisonJsonEntry {
  key: string;
  address: string;
  apis: ApiRecord[];
  tiers: TierJsonEntry[];
  tilesInfo?: TilesInfo;
}

/** Derive a short label from address key */
const KEY_LABELS: Record<string, string> = {
  sf: 'San Francisco', newton: 'Newton', sanjose: 'Winchester',
  walpole: 'Walpole', byron: 'Byron Center', vinalhaven: 'Vinalhaven',
  suttonsbay: 'Suttons Bay', losangeles: 'Los Angeles', seattle: 'Seattle',
  austin: 'Austin', denver: 'Denver', minneapolis: 'Minneapolis',
  charleston: 'Charleston', tucson: 'Tucson',
};

/** Build a LocationEntry from a JSON comparison entry */
function jsonToLocation(entry: ComparisonJsonEntry): LocationEntry {
  const findTier = (name: string): TierJsonEntry =>
    entry.tiers.find(t => t.tier === name) ?? entry.tiers[0];

  const tierToData = (t: TierJsonEntry, tier: string): TierData => {
    const g = t.genOptions;
    const p = t.property;
    // Derive sources from which APIs returned 'ok'
    let sources = 'none';
    if (tier === 'someapis') {
      const okApis = entry.apis.filter(a =>
        ['Parcl Labs', 'OpenStreetMap', 'Mapillary'].includes(a.name) && a.status === 'ok'
      ).map(a => a.name === 'Parcl Labs' ? 'Parcl' : a.name === 'OpenStreetMap' ? 'OSM' : 'Mapillary');
      sources = okApis.length > 0 ? okApis.join(' + ') : 'none';
    } else if (tier === 'allapis') {
      const extraApis = entry.apis.filter(a =>
        ['Mapbox', 'Google Solar', 'Google Street View', 'SV Image Analysis'].includes(a.name) && a.status === 'ok'
      ).map(a => a.name.replace('Google ', ''));
      sources = extraApis.length > 0 ? '+ ' + extraApis.join(' + ') : 'same as basic';
    } else if (tier === 'enriched') {
      const envApis = entry.apis.filter(a =>
        ['NLCD', 'Hardiness', 'OSM Trees', 'Overture', 'Water', 'Canopy Height', 'Land Cover'].includes(a.name) && a.status === 'ok'
      ).map(a => a.name);
      sources = envApis.length > 0 ? '+ ' + envApis.join(' + ') : 'same as all';
    }
    // Build notes from key gen options
    const shape = g.floorPlanShape ? `, ${g.floorPlanShape}-shape` : '';
    // Prefer resolvedPalette.wall (data-driven) over wallOverride (fantasy style)
    const rp = g.resolvedPalette as Record<string, unknown> | undefined;
    const wallBlock = g.wallOverride ?? rp?.wall;
    const wall = wallBlock ? `, wall=${String(wallBlock).replace('minecraft:', '')}` : '';
    const roofBlock = rp?.roofCap ?? (g.roofOverride as Record<string, unknown> | undefined)?.cap;
    const roofMat = roofBlock ? `, roofMat=${String(roofBlock).replace(/minecraft:|_slab\[.*$/g, '')}` : '';
    const roof = g.roofShape ? `, roof=${g.roofShape}` : '';
    const notes = `${g.style} ${g.floors}f ${g.width ?? '?'}x${g.length ?? '?'}${shape}${wall}${roof}${roofMat}`;
    return {
      style: String(g.style ?? 'fantasy'),
      floors: Number(g.floors ?? 2),
      grid: `${t.grid.width}\u00d7${t.grid.height}\u00d7${t.grid.depth}`,
      blocks: t.grid.blocks.toLocaleString(),
      sqft: p.sqft ? Number(p.sqft).toLocaleString() : '\u2014',
      beds: p.bedrooms ?? '\u2014',
      baths: p.bathrooms ?? '\u2014',
      year: p.yearUncertain ? '? (uncertain)' : (p.yearBuilt ?? '\u2014'),
      sources,
      notes,
    };
  };

  const noapi = findTier('noapi');
  const someapis = findTier('someapis');
  const allapis = findTier('allapis');
  // Enriched tier falls back to allapis when not present in older data
  const enriched = entry.tiers.find(t => t.tier === 'enriched') ?? allapis;

  return {
    label: KEY_LABELS[entry.key] ?? entry.key,
    address: entry.address,
    noapi: tierToData(noapi, 'noapi'),
    someapis: tierToData(someapis, 'someapis'),
    allapis: tierToData(allapis, 'allapis'),
    enriched: tierToData(enriched, 'enriched'),
    views: {
      exterior: {
        noapi: noapi.views.exterior,
        someapis: someapis.views.exterior,
        allapis: allapis.views.exterior,
        enriched: enriched.views.exterior,
      },
      cutaway: {
        noapi: noapi.views.cutaway,
        someapis: someapis.views.cutaway,
        allapis: allapis.views.cutaway,
        enriched: enriched.views.cutaway,
      },
      floor: {
        noapi: noapi.views.floor,
        someapis: someapis.views.floor,
        allapis: allapis.views.floor,
        enriched: enriched.views.floor,
      },
    },
  };
}

/** Mutable locations — populated from JSON on load */
let LOCATIONS: Record<string, LocationEntry> = {};

// ─── Constants ──────────────────────────────────────────────────────────────

let LOC_KEYS: string[] = [];
const TIERS = ['noapi', 'someapis', 'allapis', 'enriched'] as const;
const TIER_LABELS: Record<string, string> = {
  noapi: 'No API Data', someapis: 'Basic APIs', allapis: 'All APIs', enriched: 'All + Env',
};
const VIEW_TYPES = ['exterior', 'cutaway', 'floor'] as const;
const VIEW_LABELS: Record<string, string> = { exterior: 'Exterior', cutaway: 'Cutaway', floor: 'Floor Plan' };
const STAT_FIELDS = ['style', 'floors', 'grid', 'blocks', 'sqft', 'beds', 'baths', 'year', 'sources', 'notes'] as const;
const STAT_LABELS: Record<string, string> = {
  style: 'Style', floors: 'Floors', grid: 'Grid', blocks: 'Blocks',
  sqft: 'Sq Ft', beds: 'Beds', baths: 'Baths', year: 'Year Built',
  sources: 'Sources', notes: 'Notes',
};

/** Minimum gap between the two dividers (5% of slider width) */
const MIN_GAP = 0.05;

// ─── Helpers ────────────────────────────────────────────────────────────────

function esc(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Module State ───────────────────────────────────────────────────────────

let currentLoc = 'sf';
let currentView: typeof VIEW_TYPES[number] = 'exterior';
let currentLayer = 0;
/** Divider 1 position (0..1) — separates noapi from someapis */
let pos1 = 0.25;
/** Divider 2 position (0..1) — separates someapis from allapis */
let pos2 = 0.50;
/** Divider 3 position (0..1) — separates allapis from enriched */
let pos3 = 0.75;
/** Which divider is being dragged: 0=none, 1/2/3 */
let activeDivider = 0;

/** Per-API data from comparison-data.json (only for locations that have it) */
let apiData: Map<string, ComparisonJsonEntry> = new Map();

// DOM element references (set during init)
let rootEl: HTMLElement;
/** Callback to open the full 3D viewer overlay with a BlockGrid */
let onOpenViewer: ((grid: BlockGrid, label: string) => void) | null = null;

// ─── Init ───────────────────────────────────────────────────────────────────

/**
 * Initialize the 3-tier comparison viewer inside the given container.
 * Loads comparison-data.json to populate all locations and API details.
 * @param openViewer Optional callback to open the full 3D viewer overlay
 */
export function initComparison(
  container: HTMLElement,
  openViewer?: (grid: BlockGrid, label: string) => void,
): void {
  rootEl = container;
  if (openViewer) onOpenViewer = openViewer;
  buildShell();

  // Show loading state
  rootEl.querySelector('.cmp-nav')!.innerHTML = '<p style="color:var(--text-muted);padding:1rem">Loading comparison data...</p>';

  // Load comparison data — populates locations + API details
  fetch('comparison/comparison-data.json')
    .then(r => r.json())
    .then((data: ComparisonJsonEntry[]) => {
      // Build locations dynamically from JSON
      LOCATIONS = {};
      for (const entry of data) {
        LOCATIONS[entry.key] = jsonToLocation(entry);
        apiData.set(entry.key, entry);
      }
      LOC_KEYS = Object.keys(LOCATIONS);
      currentLoc = LOC_KEYS[0] || '';
      render();
    })
    .catch((err) => {
      console.error('Failed to load comparison-data.json:', err);
      rootEl.querySelector('.cmp-nav')!.innerHTML = '<p style="color:#f88;padding:1rem">Failed to load comparison data</p>';
    });
}

// ─── Shell (static DOM skeleton) ────────────────────────────────────────────

function buildShell(): void {
  rootEl.innerHTML = `
    <div class="cmp-header">
      <h2 class="cmp-title">Craftmatic — 4-Tier API Comparison</h2>
      <p class="cmp-subtitle">Drag the handles to compare: No API / Basic / All APIs / All + Environmental</p>
    </div>
    <div class="cmp-nav" id="cmp-nav"></div>
    <div class="cmp-tabs" id="cmp-tabs"></div>
    <div class="cmp-layers" id="cmp-layers"></div>
    <div class="cmp-slider-wrap">
      <div class="cmp-slider" id="cmp-slider">
        <img class="cmp-img cmp-img-noapi" id="cmp-img-noapi" alt="No API">
        <img class="cmp-img cmp-img-someapis" id="cmp-img-someapis" alt="Basic APIs">
        <img class="cmp-img cmp-img-allapis" id="cmp-img-allapis" alt="All APIs">
        <img class="cmp-img cmp-img-enriched" id="cmp-img-enriched" alt="All + Env">
        <div class="cmp-tier-label cmp-label-noapi">No API</div>
        <div class="cmp-tier-label cmp-label-someapis" id="cmp-label-some">Basic</div>
        <div class="cmp-tier-label cmp-label-allapis" id="cmp-label-all">All APIs</div>
        <div class="cmp-tier-label cmp-label-enriched">All + Env</div>
        <div class="cmp-divider cmp-divider-1" id="cmp-divider1">
          <div class="cmp-handle" id="cmp-handle1"></div>
        </div>
        <div class="cmp-divider cmp-divider-2" id="cmp-divider2">
          <div class="cmp-handle" id="cmp-handle2"></div>
        </div>
        <div class="cmp-divider cmp-divider-3" id="cmp-divider3">
          <div class="cmp-handle" id="cmp-handle3"></div>
        </div>
      </div>
    </div>
    <div class="cmp-actions" id="cmp-actions"></div>
    <div class="cmp-stats" id="cmp-stats"></div>
    <div class="cmp-api-section" id="cmp-api-section"></div>
  `;

  // Wire up triple-handle drag events
  const sliderEl = document.getElementById('cmp-slider')!;
  const handle1 = document.getElementById('cmp-handle1')!;
  const handle2 = document.getElementById('cmp-handle2')!;
  const handle3 = document.getElementById('cmp-handle3')!;

  const startDrag = (divNum: number) => (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    activeDivider = divNum;
  };
  const endDrag = () => { activeDivider = 0; };

  const moveDrag = (e: MouseEvent | TouchEvent) => {
    if (!activeDivider) return;
    e.preventDefault();
    const rect = sliderEl.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const raw = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    if (activeDivider === 1) {
      pos1 = Math.min(raw, pos2 - MIN_GAP);
    } else if (activeDivider === 2) {
      pos2 = Math.max(Math.min(raw, pos3 - MIN_GAP), pos1 + MIN_GAP);
    } else {
      pos3 = Math.max(raw, pos2 + MIN_GAP);
    }
    updateSlider();
  };

  /** Click on slider area — pick nearest of the 3 dividers */
  const jumpSlider = (e: MouseEvent | TouchEvent) => {
    if (e.target === handle1 || e.target === handle2 || e.target === handle3) return;
    const rect = sliderEl.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const raw = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const d1 = Math.abs(raw - pos1);
    const d2 = Math.abs(raw - pos2);
    const d3 = Math.abs(raw - pos3);
    const minD = Math.min(d1, d2, d3);
    if (minD === d1) {
      pos1 = Math.min(raw, pos2 - MIN_GAP);
      activeDivider = 1;
    } else if (minD === d2) {
      pos2 = Math.max(Math.min(raw, pos3 - MIN_GAP), pos1 + MIN_GAP);
      activeDivider = 2;
    } else {
      pos3 = Math.max(raw, pos2 + MIN_GAP);
      activeDivider = 3;
    }
    updateSlider();
  };

  handle1.addEventListener('mousedown', startDrag(1));
  handle1.addEventListener('touchstart', startDrag(1), { passive: false });
  handle2.addEventListener('mousedown', startDrag(2));
  handle2.addEventListener('touchstart', startDrag(2), { passive: false });
  handle3.addEventListener('mousedown', startDrag(3));
  handle3.addEventListener('touchstart', startDrag(3), { passive: false });
  sliderEl.addEventListener('mousedown', jumpSlider as EventListener);
  sliderEl.addEventListener('touchstart', jumpSlider as EventListener, { passive: false });
  document.addEventListener('mousemove', moveDrag as EventListener);
  document.addEventListener('touchmove', moveDrag as EventListener, { passive: false });
  document.addEventListener('mouseup', endDrag);
  document.addEventListener('touchend', endDrag);

  // Recalculate slider height on resize
  window.addEventListener('resize', () => {
    recalcSliderHeight();
    updateSlider();
  });
}

// ─── Render ─────────────────────────────────────────────────────────────────

function render(): void {
  buildNav();
  buildViewTabs();
  buildLayers();
  updateImages();
  buildActions();
  buildStats();
  buildApiTables();
}

function buildNav(): void {
  const el = document.getElementById('cmp-nav')!;
  el.innerHTML = '';
  for (const key of LOC_KEYS) {
    const loc = LOCATIONS[key];
    const btn = document.createElement('button');
    btn.className = 'cmp-nav-btn' + (key === currentLoc ? ' active' : '');
    btn.innerHTML = `<span class="cmp-nav-label">${esc(loc.label)}</span><span class="cmp-nav-addr">${esc(loc.address)}</span>`;
    btn.addEventListener('click', () => { currentLoc = key; currentLayer = 0; render(); });
    el.appendChild(btn);
  }
}

function buildViewTabs(): void {
  const el = document.getElementById('cmp-tabs')!;
  el.innerHTML = '';
  for (const vt of VIEW_TYPES) {
    const btn = document.createElement('button');
    btn.className = 'cmp-tab-btn' + (vt === currentView ? ' active' : '');
    btn.textContent = VIEW_LABELS[vt];
    btn.addEventListener('click', () => { currentView = vt; currentLayer = 0; render(); });
    el.appendChild(btn);
  }
}

function buildLayers(): void {
  const el = document.getElementById('cmp-layers')!;
  el.innerHTML = '';
  if (currentView === 'exterior') {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const loc = LOCATIONS[currentLoc];
  const viewData = loc.views[currentView];
  const maxLayers = Math.max(
    viewData.noapi.length, viewData.someapis.length,
    viewData.allapis.length, viewData.enriched.length,
  );
  for (let i = 0; i < maxLayers; i++) {
    const btn = document.createElement('button');
    btn.className = 'cmp-layer-btn' + (i === currentLayer ? ' active' : '');
    btn.textContent = String(i);
    btn.addEventListener('click', () => { currentLayer = i; render(); });
    el.appendChild(btn);
  }
}

// ─── Image loading + slider ─────────────────────────────────────────────────

/** Get image path for a specific tier */
function getImagePath(tier: typeof TIERS[number]): string {
  const loc = LOCATIONS[currentLoc];
  const viewData = loc.views[currentView];
  if (currentView === 'exterior') {
    return viewData[tier] as string;
  }
  const arr = (viewData as LocationViews['cutaway'])[tier];
  const idx = Math.min(currentLayer, arr.length - 1);
  return arr[idx];
}

function updateImages(): void {
  const imgNoapi = document.getElementById('cmp-img-noapi') as HTMLImageElement;
  const imgSomeapis = document.getElementById('cmp-img-someapis') as HTMLImageElement;
  const imgAllapis = document.getElementById('cmp-img-allapis') as HTMLImageElement;
  const imgEnriched = document.getElementById('cmp-img-enriched') as HTMLImageElement;
  if (!imgNoapi || !imgSomeapis || !imgAllapis || !imgEnriched) return;

  imgNoapi.src = `comparison/${getImagePath('noapi')}`;
  imgSomeapis.src = `comparison/${getImagePath('someapis')}`;
  imgAllapis.src = `comparison/${getImagePath('allapis')}`;
  imgEnriched.src = `comparison/${getImagePath('enriched')}`;

  let loaded = 0;
  const checkHeight = () => {
    loaded++;
    if (loaded >= 4) {
      recalcSliderHeight();
      updateSlider();
    }
  };
  imgNoapi.onload = checkHeight;
  imgSomeapis.onload = checkHeight;
  imgAllapis.onload = checkHeight;
  imgEnriched.onload = checkHeight;
  if (imgNoapi.complete) loaded++;
  if (imgSomeapis.complete) loaded++;
  if (imgAllapis.complete) loaded++;
  if (imgEnriched.complete) loaded++;
  if (loaded >= 4) checkHeight();
}

/** Recalculate slider container height based on loaded image aspect ratios */
function recalcSliderHeight(): void {
  const sliderEl = document.getElementById('cmp-slider');
  const imgNoapi = document.getElementById('cmp-img-noapi') as HTMLImageElement;
  const imgSomeapis = document.getElementById('cmp-img-someapis') as HTMLImageElement;
  const imgAllapis = document.getElementById('cmp-img-allapis') as HTMLImageElement;
  if (!sliderEl || !imgNoapi || !imgSomeapis || !imgAllapis) return;

  const imgEnriched = document.getElementById('cmp-img-enriched') as HTMLImageElement;
  const containerW = sliderEl.offsetWidth;
  const ratios = [imgNoapi, imgSomeapis, imgAllapis, imgEnriched].filter(Boolean).map(
    img => img.naturalHeight / (img.naturalWidth || 1)
  );
  const maxRatio = Math.max(...ratios);
  const h = Math.min(containerW * maxRatio, 800);
  sliderEl.style.height = Math.max(h, 250) + 'px';
}

function updateSlider(): void {
  const sliderEl = document.getElementById('cmp-slider');
  const imgSomeapis = document.getElementById('cmp-img-someapis') as HTMLImageElement;
  const imgAllapis = document.getElementById('cmp-img-allapis') as HTMLImageElement;
  const imgEnriched = document.getElementById('cmp-img-enriched') as HTMLImageElement;
  const divider1 = document.getElementById('cmp-divider1');
  const divider2 = document.getElementById('cmp-divider2');
  const divider3 = document.getElementById('cmp-divider3');
  const labelSome = document.getElementById('cmp-label-some');
  const labelAll = document.getElementById('cmp-label-all');
  if (!sliderEl || !imgSomeapis || !imgAllapis || !imgEnriched || !divider1 || !divider2 || !divider3) return;

  const w = sliderEl.offsetWidth;
  const x1 = Math.round(pos1 * w);
  const x2 = Math.round(pos2 * w);
  const x3 = Math.round(pos3 * w);

  // Clip each tier image from the left at its divider position
  imgSomeapis.style.clipPath = `inset(0 0 0 ${x1}px)`;
  imgAllapis.style.clipPath = `inset(0 0 0 ${x2}px)`;
  imgEnriched.style.clipPath = `inset(0 0 0 ${x3}px)`;
  divider1.style.left = x1 + 'px';
  divider2.style.left = x2 + 'px';
  divider3.style.left = x3 + 'px';

  // Position "Basic" label between dividers 1 and 2
  if (labelSome) {
    const midX = (x1 + x2) / 2;
    labelSome.style.left = midX + 'px';
    labelSome.style.transform = 'translateX(-50%)';
  }
  // Position "All APIs" label between dividers 2 and 3
  if (labelAll) {
    const midX = (x2 + x3) / 2;
    labelAll.style.left = midX + 'px';
    labelAll.style.transform = 'translateX(-50%)';
  }
}

// ─── Action Buttons (Generate / Download per tier) ──────────────────────────

/** Parse grid string like "78×20×40" into {w, h, l} or return undefined */
function parseGrid(grid: string): { w: number; l: number } | undefined {
  const m = grid.match(/(\d+)\s*[\u00d7x]\s*(\d+)\s*[\u00d7x]\s*(\d+)/);
  if (!m) return undefined;
  return { w: parseInt(m[1]), l: parseInt(m[3]) };
}

/** Build GenerationOptions from a tier's hardcoded data */
function tierToGenOptions(tier: TierData, locKey: string): GenerationOptions {
  const dims = parseGrid(tier.grid);
  return {
    type: 'house',
    style: tier.style as StyleName,
    floors: tier.floors,
    width: dims?.w,
    length: dims?.l,
    seed: hashCode(locKey + tier.style + tier.floors),
  };
}

/** Simple string hash for deterministic seeds */
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Generate a BlockGrid for the given tier.
 *  Uses stored genOptions from JSON when available for accuracy,
 *  falls back to reconstructing from tier stats. */
function generateForTier(tier: typeof TIERS[number]): BlockGrid {
  // Try to use full genOptions from JSON data (most accurate)
  const jsonEntry = apiData.get(currentLoc);
  if (jsonEntry?.tiers) {
    const tierJson = jsonEntry.tiers.find(t => t.tier === tier);
    if (tierJson?.genOptions) {
      const g = tierJson.genOptions;
      return generateStructure({
        type: 'house',
        style: g.style as StyleName,
        floors: g.floors as number,
        width: g.width as number | undefined,
        length: g.length as number | undefined,
        // Use stored seed from pipeline; fall back to hash if not present (old data)
        seed: (g.seed as number | undefined) ?? hashCode(currentLoc + '-' + tier + String(g.style) + String(g.floors)),
        wallOverride: g.wallOverride as string | undefined,
        trimOverride: g.trimOverride as string | undefined,
        doorOverride: g.doorOverride as string | undefined,
        roofShape: g.roofShape as GenerationOptions['roofShape'],
        roofOverride: g.roofOverride as GenerationOptions['roofOverride'],
        floorPlanShape: g.floorPlanShape as GenerationOptions['floorPlanShape'],
        windowSpacing: g.windowSpacing as number | undefined,
        roofHeightOverride: g.roofHeightOverride as number | undefined,
        features: g.features as GenerationOptions['features'],
        orientation: g.orientation as GenerationOptions['orientation'],
        season: g.season as GenerationOptions['season'],
        resolvedPalette: g.resolvedPalette as GenerationOptions['resolvedPalette'],
        landscape: g.landscape as GenerationOptions['landscape'],
      });
    }
  }
  // Fallback: reconstruct from tier display data
  const loc = LOCATIONS[currentLoc];
  const tierData = loc[tier];
  return generateStructure(tierToGenOptions(tierData, currentLoc + '-' + tier));
}

const DL_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
const VIEW_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';
const JSON_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';

/** Download a JSON blob as a file */
function downloadJSON(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function buildActions(): void {
  const el = document.getElementById('cmp-actions')!;
  const loc = LOCATIONS[currentLoc];
  el.innerHTML = '';

  for (const tier of TIERS) {
    const tierData = loc[tier];
    const label = TIER_LABELS[tier];

    // Download .schem button
    const dlBtn = document.createElement('button');
    dlBtn.className = 'cmp-action-btn';
    dlBtn.innerHTML = `${DL_ICON} ${label} .schem`;
    dlBtn.addEventListener('click', () => {
      try {
        const grid = generateForTier(tier);
        const filename = `${currentLoc}-${tier}_${tierData.style}_${tierData.floors}f.schem`;
        exportSchem(grid, filename);
      } catch (err) {
        console.error('Generation failed:', err);
      }
    });
    el.appendChild(dlBtn);

    // Download JSON button — exports full property + genOptions for this tier
    const jsonEntry = apiData.get(currentLoc);
    if (jsonEntry?.tiers) {
      const tierJson = jsonEntry.tiers.find(t => t.tier === tier);
      if (tierJson) {
        const jsonBtn = document.createElement('button');
        jsonBtn.className = 'cmp-action-btn';
        jsonBtn.innerHTML = `${JSON_ICON} ${label} JSON`;
        jsonBtn.addEventListener('click', () => {
          downloadJSON(
            { property: tierJson.property, genOptions: tierJson.genOptions },
            `${currentLoc}-${tier}.json`,
          );
        });
        el.appendChild(jsonBtn);
      }
    }

    // Open in 3D viewer button (only if callback provided)
    if (onOpenViewer) {
      const viewBtn = document.createElement('button');
      viewBtn.className = 'cmp-action-btn';
      viewBtn.innerHTML = `${VIEW_ICON} ${label} 3D`;
      viewBtn.addEventListener('click', () => {
        try {
          const grid = generateForTier(tier);
          onOpenViewer!(grid, `${loc.label} — ${label}`);
        } catch (err) {
          console.error('Generation failed:', err);
        }
      });
      el.appendChild(viewBtn);
    }
  }
}

// ─── Stats Tables (3 tier cards) ────────────────────────────────────────────

function buildStats(): void {
  const el = document.getElementById('cmp-stats')!;
  const loc = LOCATIONS[currentLoc];

  const makeTable = (tier: typeof TIERS[number], prevTier: typeof TIERS[number] | null) => {
    const data = loc[tier];
    const prev = prevTier ? loc[prevTier] : null;
    let html = `<div class="cmp-stat-card ${tier}"><h4>${TIER_LABELS[tier]}</h4><table>`;
    for (const field of STAT_FIELDS) {
      // Combine beds/baths into one row
      if (field === 'baths') continue;
      const val = field === 'beds'
        ? `${data.beds} / ${data.baths}`
        : String((data as Record<string, unknown>)[field] ?? '\u2014');
      const prevVal = prev
        ? (field === 'beds' ? `${prev.beds} / ${prev.baths}` : String((prev as Record<string, unknown>)[field] ?? '\u2014'))
        : null;
      const changed = prevVal && val !== prevVal ? ' class="changed"' : '';
      const label = field === 'beds' ? 'Beds / Baths' : STAT_LABELS[field];
      html += `<tr><td>${label}</td><td${changed}>${esc(val)}</td></tr>`;
    }
    html += '</table></div>';
    return html;
  };

  let html = makeTable('noapi', null) + makeTable('someapis', 'noapi')
    + makeTable('allapis', 'someapis') + makeTable('enriched', 'allapis');

  // Add 3D Tiles comparison card if tiles data exists for this location
  const jsonEntry = apiData.get(currentLoc);
  if (jsonEntry?.tilesInfo) {
    const t = jsonEntry.tilesInfo;
    const enrichedTier = loc.enriched;
    html += `<div class="cmp-stat-card tiles"><h4>3D Tiles (Google)</h4><table>`;
    html += `<tr><td>Grid</td><td>${t.grid.width}\u00d7${t.grid.height}\u00d7${t.grid.depth}</td></tr>`;
    html += `<tr><td>Blocks</td><td>${t.grid.blocks.toLocaleString()}</td></tr>`;
    html += `<tr><td>Palette</td><td>${t.paletteSize} materials</td></tr>`;
    html += `<tr><td>Resolution</td><td>${t.resolution} block/m</td></tr>`;
    html += `<tr><td>Radius</td><td>${t.radiusMeters} m</td></tr>`;
    // Show delta vs enriched procedural
    const procBlocks = parseInt(enrichedTier.blocks.replace(/,/g, ''));
    if (procBlocks > 0) {
      const ratio = (t.grid.blocks / procBlocks).toFixed(1);
      html += `<tr><td>vs Enriched</td><td class="changed">${ratio}x blocks</td></tr>`;
    }
    html += '</table></div>';
  }

  el.innerHTML = html;
}

// ─── API Data Tables (from comparison-data.json) ────────────────────────────

/** Build a thumbnail image path from API record data when possible.
 *  Uses pre-downloaded static files in comparison/ (no API key dependency). */
function buildApiThumbnail(api: ApiRecord, locKey: string): string | null {
  if (api.status !== 'ok') return null;

  if (api.name === 'Google Street View' && api.data.panoId) {
    return `comparison/${locKey}-streetview.jpg`;
  }

  if (api.name === 'Mapillary' && api.data.bestImageId) {
    return `comparison/${locKey}-mapillary.jpg`;
  }

  return null;
}

/** Build inline color swatch HTML for SV Image Analysis */
function buildColorSwatches(api: ApiRecord): string {
  if (api.name !== 'SV Image Analysis' || api.status !== 'ok') return '';
  const d = api.data;
  const swatches: { label: string; color: string; block: string }[] = [];
  if (d.wallColor) swatches.push({ label: 'Wall', color: String(d.wallColor), block: String(d.wallBlock ?? '') });
  if (d.roofColor) swatches.push({ label: 'Roof', color: String(d.roofColor), block: String(d.roofBlock ?? '') });
  if (d.trimColor) swatches.push({ label: 'Trim', color: String(d.trimColor), block: String(d.trimBlock ?? '') });
  if (swatches.length === 0) return '';

  let html = '<div class="cmp-api-swatches">';
  for (const s of swatches) {
    html += `<div class="cmp-api-swatch" title="${esc(s.block)}"><span class="cmp-swatch-color" style="background:${esc(s.color)}"></span><span class="cmp-swatch-label">${esc(s.label)}</span></div>`;
  }
  html += '</div>';
  return html;
}

function buildApiTables(): void {
  const el = document.getElementById('cmp-api-section');
  if (!el) return;

  const locData = apiData.get(currentLoc);
  if (!locData) {
    el.innerHTML = '';
    return;
  }

  const activeCount = locData.apis.filter(a => a.status === 'ok').length;
  let html = `<h3 class="cmp-api-heading">API Data Sources (${activeCount}/${locData.apis.length} active)</h3>`;
  html += '<div class="cmp-api-grid">';

  for (const api of locData.apis) {
    html += '<div class="cmp-api-card">';
    html += `<div class="cmp-api-header"><span class="cmp-api-name">${esc(api.name)}</span><span class="cmp-api-status ${api.status}">${api.status}</span></div>`;

    if (api.error && api.status !== 'ok') {
      html += `<p class="cmp-api-error">${esc(api.error)}</p>`;
    }

    // Thumbnail image (Street View panorama, Mapillary photo) — static files
    const thumbUrl = buildApiThumbnail(api, currentLoc);
    if (thumbUrl) {
      html += `<a href="${thumbUrl}" target="_blank" rel="noopener" class="cmp-api-thumb-link"><img class="cmp-api-thumb" src="${thumbUrl}" alt="${esc(api.name)} image" loading="lazy"></a>`;
    }

    // Color swatches (SV Image Analysis)
    html += buildColorSwatches(api);

    // Returned data
    if (api.data && Object.keys(api.data).length > 0) {
      html += '<table class="cmp-api-table">';
      for (const [k, v] of Object.entries(api.data)) {
        if (v === null || v === undefined) continue;
        html += `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`;
      }
      html += '</table>';
    }

    // Fields set
    if (api.fieldsSet?.length > 0) {
      html += '<div class="cmp-tag-row"><span class="cmp-tag-label">Sets</span><div class="cmp-tags cmp-tags-green">';
      for (const f of api.fieldsSet) html += `<span class="cmp-tag">${esc(f)}</span>`;
      html += '</div></div>';
    }

    // Impact
    if (api.impactedGenFields?.length > 0) {
      html += '<div class="cmp-tag-row"><span class="cmp-tag-label">Impacts</span><div class="cmp-tags cmp-tags-blue">';
      for (const f of api.impactedGenFields) html += `<span class="cmp-tag">${esc(f)}</span>`;
      html += '</div></div>';
    }

    html += '</div>';
  }

  html += '</div>';
  el.innerHTML = html;
}
