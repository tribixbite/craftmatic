/**
 * Comparison — 3-tier API data comparison viewer with dual-handle image slider.
 *
 * Shows 7 addresses with 3 tiers each: No API / Basic APIs / All APIs.
 * The dual slider lets users compare all 3 tiers simultaneously.
 * Also loads comparison-data.json (if available) for detailed per-API data cards.
 */

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

interface ComparisonResult {
  key: string;
  address: string;
  apis: ApiRecord[];
  property: Record<string, unknown>;
  genOptions: Record<string, unknown>;
  grid: { width: number; height: number; depth: number; blocks: number };
  views: {
    exterior: { api: string };
    cutaway: string[];
    floor: string[];
  };
}

// ─── Hardcoded location data (7 addresses × 3 tiers) ───────────────────────

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
  exterior: { noapi: string; someapis: string; allapis: string };
  cutaway: { noapi: string[]; someapis: string[]; allapis: string[] };
  floor: { noapi: string[]; someapis: string[]; allapis: string[] };
}

interface LocationEntry {
  label: string;
  address: string;
  noapi: TierData;
  someapis: TierData;
  allapis: TierData;
  views: LocationViews;
}

const LOCATIONS: Record<string, LocationEntry> = {
  sf: {
    label: 'San Francisco',
    address: '2340 Francisco St, San Francisco, CA 94123',
    noapi: {
      style: 'fantasy', floors: 2, grid: '78\u00d720\u00d740', blocks: '15,190',
      sqft: '\u2014', beds: '\u2014', baths: '\u2014', year: '\u2014',
      sources: 'none', notes: 'Generic L-shape compound',
    },
    someapis: {
      style: 'desert', floors: 4, grid: '56\u00d725\u00d734', blocks: '9,901',
      sqft: '13,905', beds: 12, baths: 12, year: 1929,
      sources: 'Parcl + OSM + Mapillary',
      notes: 'Multi-family detected, flat roof, OSM 8\u00d717 footprint',
    },
    allapis: {
      style: 'desert', floors: 4, grid: '56\u00d725\u00d734', blocks: '9,901',
      sqft: '13,905', beds: 12, baths: 12, year: 1929,
      sources: '+ Mapbox (13.0m) + StreetView',
      notes: 'Mapbox confirms 4f (13m/3.5=3.7), OSM levels take priority',
    },
    views: {
      exterior: { noapi: 'sf-noapi_exterior.jpg', someapis: 'sf-someapis_exterior.jpg', allapis: 'sf-allapis_exterior.jpg' },
      cutaway: {
        noapi: [0, 1, 2, 3].map(i => `sf-noapi_cutaway_${i}.jpg`),
        someapis: [0, 1, 2, 3].map(i => `sf-someapis_cutaway_${i}.jpg`),
        allapis: [0, 1, 2, 3].map(i => `sf-allapis_cutaway_${i}.jpg`),
      },
      floor: {
        noapi: [0, 1, 2, 3].map(i => `sf-noapi_floor_${i}.jpg`),
        someapis: [0, 1, 2, 3].map(i => `sf-someapis_floor_${i}.jpg`),
        allapis: [0, 1, 2, 3].map(i => `sf-allapis_floor_${i}.jpg`),
      },
    },
  },
  newton: {
    label: 'Newton',
    address: '240 Highland St, Newton, MA 02465',
    noapi: {
      style: 'fantasy', floors: 2, grid: '78\u00d720\u00d740', blocks: '15,190',
      sqft: '\u2014', beds: '\u2014', baths: '\u2014', year: '\u2014',
      sources: 'none', notes: 'Generic L-shape compound',
    },
    someapis: {
      style: 'fantasy', floors: 3, grid: '69\u00d725\u00d738', blocks: '14,313',
      sqft: '9,094', beds: 9, baths: 5, year: '? (uncertain)',
      sources: 'Parcl + OSM + Mapillary',
      notes: 'Victorian proxy: fantasy 3f + turret + bay window, OSM 17\u00d721',
    },
    allapis: {
      style: 'fantasy', floors: 3, grid: '69\u00d725\u00d738', blocks: '14,313',
      sqft: '9,094', beds: 9, baths: 5, year: '? (uncertain)',
      sources: '+ Mapbox (7.5m) + StreetView',
      notes: 'OSM levels (3) overrides Mapbox height (7.5m\u21922f)',
    },
    views: {
      exterior: { noapi: 'sf-noapi_exterior.jpg', someapis: 'newton-someapis_exterior.jpg', allapis: 'newton-allapis_exterior.jpg' },
      cutaway: {
        noapi: [0, 1, 2, 3].map(i => `sf-noapi_cutaway_${i}.jpg`),
        someapis: [0, 1, 2].map(i => `newton-someapis_cutaway_${i}.jpg`),
        allapis: [0, 1, 2].map(i => `newton-allapis_cutaway_${i}.jpg`),
      },
      floor: {
        noapi: [0, 1, 2, 3].map(i => `sf-noapi_floor_${i}.jpg`),
        someapis: [0, 1, 2].map(i => `newton-someapis_floor_${i}.jpg`),
        allapis: [0, 1, 2].map(i => `newton-allapis_floor_${i}.jpg`),
      },
    },
  },
  sanjose: {
    label: 'Winchester',
    address: '525 S Winchester Blvd, San Jose, CA 95128',
    noapi: {
      style: 'fantasy', floors: 2, grid: '78\u00d720\u00d740', blocks: '15,190',
      sqft: '\u2014', beds: '\u2014', baths: '\u2014', year: '\u2014',
      sources: 'none', notes: 'Generic L-shape compound',
    },
    someapis: {
      style: 'fantasy', floors: 5, grid: '135\u00d735\u00d777', blocks: '77,895',
      sqft: '24,000', beds: 3, baths: 2, year: 1901,
      sources: 'Parcl + OSM + Mapillary',
      notes: 'Winchester Mystery House \u2014 OSM 53\u00d760',
    },
    allapis: {
      style: 'fantasy', floors: 5, grid: '135\u00d735\u00d777', blocks: '79,442',
      sqft: '24,000', beds: 3, baths: 2, year: 1901,
      sources: '+ Mapbox (27.9m) + StreetView',
      notes: 'Mapbox 27.9m (8f) capped at 5f by OSM levels',
    },
    views: {
      exterior: { noapi: 'sf-noapi_exterior.jpg', someapis: 'sanjose-someapis_exterior.jpg', allapis: 'sanjose-allapis_exterior.jpg' },
      cutaway: {
        noapi: [0, 1, 2, 3].map(i => `sf-noapi_cutaway_${i}.jpg`),
        someapis: [0, 1, 2, 3, 4].map(i => `sanjose-someapis_cutaway_${i}.jpg`),
        allapis: [0, 1, 2, 3, 4].map(i => `sanjose-allapis_cutaway_${i}.jpg`),
      },
      floor: {
        noapi: [0, 1, 2, 3].map(i => `sf-noapi_floor_${i}.jpg`),
        someapis: [0, 1, 2, 3, 4].map(i => `sanjose-someapis_floor_${i}.jpg`),
        allapis: [0, 1, 2, 3, 4].map(i => `sanjose-allapis_floor_${i}.jpg`),
      },
    },
  },
  walpole: {
    label: 'Walpole',
    address: '13 Union St, Walpole, NH 03608',
    noapi: {
      style: 'fantasy', floors: 2, grid: '78\u00d720\u00d740', blocks: '15,190',
      sqft: '\u2014', beds: '\u2014', baths: '\u2014', year: '\u2014',
      sources: 'none', notes: 'Generic L-shape compound',
    },
    someapis: {
      style: 'colonial', floors: 3, grid: '51\u00d723\u00d730', blocks: '8,739',
      sqft: '5,860', beds: 5, baths: 5, year: '? (uncertain)',
      sources: 'Parcl + OSM',
      notes: 'Colonial 3f (NE Federal fallback), white quartz + brick',
    },
    allapis: {
      style: 'colonial', floors: 2, grid: '55\u00d718\u00d731', blocks: '8,042',
      sqft: '5,860', beds: 5, baths: 5, year: '? (uncertain)',
      sources: '+ Mapbox (8.5m) + StreetView',
      notes: 'Mapbox 8.5m \u2192 2f (was 3f from heuristic) \u2014 more accurate for Federal',
    },
    views: {
      exterior: { noapi: 'sf-noapi_exterior.jpg', someapis: 'walpole-someapis_exterior.jpg', allapis: 'walpole-allapis_exterior.jpg' },
      cutaway: {
        noapi: [0, 1, 2, 3].map(i => `sf-noapi_cutaway_${i}.jpg`),
        someapis: [0, 1, 2].map(i => `walpole-someapis_cutaway_${i}.jpg`),
        allapis: [0, 1].map(i => `walpole-allapis_cutaway_${i}.jpg`),
      },
      floor: {
        noapi: [0, 1, 2, 3].map(i => `sf-noapi_floor_${i}.jpg`),
        someapis: [0, 1, 2].map(i => `walpole-someapis_floor_${i}.jpg`),
        allapis: [0, 1].map(i => `walpole-allapis_floor_${i}.jpg`),
      },
    },
  },
  byron: {
    label: 'Byron Center',
    address: '2431 72nd St SW, Byron Center, MI 49315',
    noapi: {
      style: 'fantasy', floors: 2, grid: '78\u00d720\u00d740', blocks: '15,190',
      sqft: '\u2014', beds: '\u2014', baths: '\u2014', year: '\u2014',
      sources: 'none', notes: 'Generic L-shape compound',
    },
    someapis: {
      style: 'modern', floors: 2, grid: '66\u00d715\u00d738', blocks: '7,807',
      sqft: '3,040', beds: 2, baths: 2, year: 1980,
      sources: 'Parcl + OSM + Mapillary',
      notes: 'Modern 2f \u2014 OSM 14\u00d716, flat roof + cantilever',
    },
    allapis: {
      style: 'modern', floors: 2, grid: '66\u00d715\u00d738', blocks: '7,807',
      sqft: '3,040', beds: 2, baths: 2, year: 1980,
      sources: '+ StreetView (2025-05)',
      notes: 'OSM levels present, no additional Mapbox height data',
    },
    views: {
      exterior: { noapi: 'sf-noapi_exterior.jpg', someapis: 'byron-someapis_exterior.jpg', allapis: 'byron-allapis_exterior.jpg' },
      cutaway: {
        noapi: [0, 1, 2, 3].map(i => `sf-noapi_cutaway_${i}.jpg`),
        someapis: [0, 1].map(i => `byron-someapis_cutaway_${i}.jpg`),
        allapis: [0, 1].map(i => `byron-allapis_cutaway_${i}.jpg`),
      },
      floor: {
        noapi: [0, 1, 2, 3].map(i => `sf-noapi_floor_${i}.jpg`),
        someapis: [0, 1].map(i => `byron-someapis_floor_${i}.jpg`),
        allapis: [0, 1].map(i => `byron-allapis_floor_${i}.jpg`),
      },
    },
  },
  vinalhaven: {
    label: 'Vinalhaven',
    address: '216 Zekes Point Rd, Vinalhaven, ME 04863',
    noapi: {
      style: 'fantasy', floors: 2, grid: '78\u00d720\u00d740', blocks: '15,190',
      sqft: '\u2014', beds: '\u2014', baths: '\u2014', year: '\u2014',
      sources: 'none', notes: 'Generic L-shape compound',
    },
    someapis: {
      style: 'rustic', floors: 2, grid: '55\u00d717\u00d730', blocks: '6,673',
      sqft: '2,000', beds: 3, baths: 2, year: '? (uncertain)',
      sources: 'Parcl',
      notes: 'Rustic 2f (island ME fallback), spruce + cobble',
    },
    allapis: {
      style: 'rustic', floors: 2, grid: '55\u00d717\u00d730', blocks: '6,673',
      sqft: '2,000', beds: 3, baths: 2, year: '? (uncertain)',
      sources: 'Parcl only',
      notes: 'No Mapbox/StreetView coverage (remote island)',
    },
    views: {
      exterior: { noapi: 'sf-noapi_exterior.jpg', someapis: 'vinalhaven-someapis_exterior.jpg', allapis: 'vinalhaven-allapis_exterior.jpg' },
      cutaway: {
        noapi: [0, 1, 2, 3].map(i => `sf-noapi_cutaway_${i}.jpg`),
        someapis: [0, 1].map(i => `vinalhaven-someapis_cutaway_${i}.jpg`),
        allapis: [0, 1].map(i => `vinalhaven-allapis_cutaway_${i}.jpg`),
      },
      floor: {
        noapi: [0, 1, 2, 3].map(i => `sf-noapi_floor_${i}.jpg`),
        someapis: [0, 1].map(i => `vinalhaven-someapis_floor_${i}.jpg`),
        allapis: [0, 1].map(i => `vinalhaven-allapis_floor_${i}.jpg`),
      },
    },
  },
  suttonsbay: {
    label: 'Suttons Bay',
    address: '5835 S Bridget Rose Ln, Suttons Bay, MI 49682',
    noapi: {
      style: 'fantasy', floors: 2, grid: '78\u00d720\u00d740', blocks: '15,190',
      sqft: '\u2014', beds: '\u2014', baths: '\u2014', year: '\u2014',
      sources: 'none', notes: 'Generic L-shape compound',
    },
    someapis: {
      style: 'rustic', floors: 2, grid: '55\u00d717\u00d730', blocks: '6,669',
      sqft: '2,000', beds: 3, baths: 2, year: '? (uncertain)',
      sources: 'Parcl + Mapillary',
      notes: 'Rustic 2f (rural MI fallback), spruce + cobble',
    },
    allapis: {
      style: 'rustic', floors: 2, grid: '55\u00d717\u00d730', blocks: '6,669',
      sqft: '2,000', beds: 3, baths: 2, year: '? (uncertain)',
      sources: '+ Mapillary',
      notes: 'No Mapbox/StreetView coverage (rural MI)',
    },
    views: {
      exterior: { noapi: 'sf-noapi_exterior.jpg', someapis: 'suttonsbay-someapis_exterior.jpg', allapis: 'suttonsbay-allapis_exterior.jpg' },
      cutaway: {
        noapi: [0, 1, 2, 3].map(i => `sf-noapi_cutaway_${i}.jpg`),
        someapis: [0, 1].map(i => `suttonsbay-someapis_cutaway_${i}.jpg`),
        allapis: [0, 1].map(i => `suttonsbay-allapis_cutaway_${i}.jpg`),
      },
      floor: {
        noapi: [0, 1, 2, 3].map(i => `sf-noapi_floor_${i}.jpg`),
        someapis: [0, 1].map(i => `suttonsbay-someapis_floor_${i}.jpg`),
        allapis: [0, 1].map(i => `suttonsbay-allapis_floor_${i}.jpg`),
      },
    },
  },
};

// ─── Constants ──────────────────────────────────────────────────────────────

const LOC_KEYS = Object.keys(LOCATIONS);
const TIERS = ['noapi', 'someapis', 'allapis'] as const;
const TIER_LABELS: Record<string, string> = { noapi: 'No API Data', someapis: 'Basic APIs', allapis: 'All APIs' };
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
/** Left divider position (0..1) — separates noapi from someapis */
let pos1 = 0.33;
/** Right divider position (0..1) — separates someapis from allapis */
let pos2 = 0.66;
/** Which divider is being dragged: 0=none, 1=left, 2=right */
let activeDivider = 0;

/** Per-API data from comparison-data.json (only for locations that have it) */
let apiData: Map<string, ComparisonResult> = new Map();

// DOM element references (set during init)
let rootEl: HTMLElement;

// ─── Init ───────────────────────────────────────────────────────────────────

/**
 * Initialize the 3-tier comparison viewer inside the given container.
 * Optionally loads comparison-data.json for detailed per-API cards.
 */
export function initComparison(container: HTMLElement): void {
  rootEl = container;
  buildShell();
  render();

  // Try to load detailed per-API data (non-blocking — viewer works without it)
  fetch('comparison/comparison-data.json')
    .then(r => r.json())
    .then((data: ComparisonResult[]) => {
      for (const d of data) apiData.set(d.key, d);
      // Re-render to show API cards if currently visible
      buildApiTables();
    })
    .catch(() => { /* comparison-data.json not available — that's fine */ });
}

// ─── Shell (static DOM skeleton) ────────────────────────────────────────────

function buildShell(): void {
  rootEl.innerHTML = `
    <div class="cmp-header">
      <h2 class="cmp-title">Craftmatic — 3-Tier API Comparison</h2>
      <p class="cmp-subtitle">Drag the two handles to compare: No API / Basic APIs / All APIs</p>
    </div>
    <div class="cmp-nav" id="cmp-nav"></div>
    <div class="cmp-tabs" id="cmp-tabs"></div>
    <div class="cmp-layers" id="cmp-layers"></div>
    <div class="cmp-slider-wrap">
      <div class="cmp-slider" id="cmp-slider">
        <img class="cmp-img cmp-img-noapi" id="cmp-img-noapi" alt="No API">
        <img class="cmp-img cmp-img-someapis" id="cmp-img-someapis" alt="Basic APIs">
        <img class="cmp-img cmp-img-allapis" id="cmp-img-allapis" alt="All APIs">
        <div class="cmp-tier-label cmp-label-noapi">No API</div>
        <div class="cmp-tier-label cmp-label-someapis" id="cmp-label-some">Basic APIs</div>
        <div class="cmp-tier-label cmp-label-allapis">All APIs</div>
        <div class="cmp-divider cmp-divider-1" id="cmp-divider1">
          <div class="cmp-handle" id="cmp-handle1"></div>
        </div>
        <div class="cmp-divider cmp-divider-2" id="cmp-divider2">
          <div class="cmp-handle" id="cmp-handle2"></div>
        </div>
      </div>
    </div>
    <div class="cmp-stats" id="cmp-stats"></div>
    <div class="cmp-api-section" id="cmp-api-section"></div>
  `;

  // Wire up dual-handle drag events
  const sliderEl = document.getElementById('cmp-slider')!;
  const handle1 = document.getElementById('cmp-handle1')!;
  const handle2 = document.getElementById('cmp-handle2')!;

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
    } else {
      pos2 = Math.max(raw, pos1 + MIN_GAP);
    }
    updateSlider();
  };

  /** Click on slider area — pick nearest divider */
  const jumpSlider = (e: MouseEvent | TouchEvent) => {
    if (e.target === handle1 || e.target === handle2) return;
    const rect = sliderEl.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const raw = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const d1 = Math.abs(raw - pos1);
    const d2 = Math.abs(raw - pos2);
    if (d1 <= d2) {
      pos1 = Math.min(raw, pos2 - MIN_GAP);
      activeDivider = 1;
    } else {
      pos2 = Math.max(raw, pos1 + MIN_GAP);
      activeDivider = 2;
    }
    updateSlider();
  };

  handle1.addEventListener('mousedown', startDrag(1));
  handle1.addEventListener('touchstart', startDrag(1), { passive: false });
  handle2.addEventListener('mousedown', startDrag(2));
  handle2.addEventListener('touchstart', startDrag(2), { passive: false });
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
    viewData.noapi.length, viewData.someapis.length, viewData.allapis.length
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
  if (!imgNoapi || !imgSomeapis || !imgAllapis) return;

  imgNoapi.src = `comparison/${getImagePath('noapi')}`;
  imgSomeapis.src = `comparison/${getImagePath('someapis')}`;
  imgAllapis.src = `comparison/${getImagePath('allapis')}`;

  let loaded = 0;
  const checkHeight = () => {
    loaded++;
    if (loaded >= 3) {
      recalcSliderHeight();
      updateSlider();
    }
  };
  imgNoapi.onload = checkHeight;
  imgSomeapis.onload = checkHeight;
  imgAllapis.onload = checkHeight;
  if (imgNoapi.complete) loaded++;
  if (imgSomeapis.complete) loaded++;
  if (imgAllapis.complete) loaded++;
  if (loaded >= 3) checkHeight();
}

/** Recalculate slider container height based on loaded image aspect ratios */
function recalcSliderHeight(): void {
  const sliderEl = document.getElementById('cmp-slider');
  const imgNoapi = document.getElementById('cmp-img-noapi') as HTMLImageElement;
  const imgSomeapis = document.getElementById('cmp-img-someapis') as HTMLImageElement;
  const imgAllapis = document.getElementById('cmp-img-allapis') as HTMLImageElement;
  if (!sliderEl || !imgNoapi || !imgSomeapis || !imgAllapis) return;

  const containerW = sliderEl.offsetWidth;
  const ratios = [imgNoapi, imgSomeapis, imgAllapis].map(
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
  const divider1 = document.getElementById('cmp-divider1');
  const divider2 = document.getElementById('cmp-divider2');
  const labelSome = document.getElementById('cmp-label-some');
  if (!sliderEl || !imgSomeapis || !imgAllapis || !divider1 || !divider2) return;

  const w = sliderEl.offsetWidth;
  const x1 = Math.round(pos1 * w);
  const x2 = Math.round(pos2 * w);

  imgSomeapis.style.clipPath = `inset(0 0 0 ${x1}px)`;
  imgAllapis.style.clipPath = `inset(0 0 0 ${x2}px)`;
  divider1.style.left = x1 + 'px';
  divider2.style.left = x2 + 'px';

  // Position the "Basic APIs" label between the two dividers
  if (labelSome) {
    const midX = (x1 + x2) / 2;
    labelSome.style.left = midX + 'px';
    labelSome.style.transform = 'translateX(-50%)';
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

  el.innerHTML = makeTable('noapi', null) + makeTable('someapis', 'noapi') + makeTable('allapis', 'someapis');
}

// ─── API Data Tables (from comparison-data.json) ────────────────────────────

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
