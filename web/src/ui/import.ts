/**
 * Import tab — address-to-structure generation.
 * Takes a real estate address, geocodes it, fetches property data via Parcl Labs API,
 * shows satellite imagery with seasonal weather overlay, accepts property details,
 * and generates a Minecraft structure.
 */

import type { StructureType, StyleName, RoomType, BlockState } from '@craft/types/index.js';
import type { GenerationOptions } from '@craft/types/index.js';
import { generateStructure } from '@craft/gen/generator.js';
import { BlockGrid } from '@craft/schem/types.js';
import { geocodeAddress, type GeocodingResult } from '@ui/import-geocoder.js';
import { composeSatelliteView, type SeasonalWeather } from '@ui/import-satellite.js';
import { analyzeFloorPlan, type FloorPlanAnalysis } from '@ui/import-floorplan.js';
import {
  searchParclProperty, getParclApiKey, setParclApiKey, hasParclApiKey,
  mapParclPropertyType, type ParclPropertyData,
} from '@ui/import-parcl.js';
import {
  searchRentCastProperty, getRentCastApiKey, setRentCastApiKey, hasRentCastApiKey,
  mapExteriorToWall, type RentCastPropertyData,
} from '@ui/import-rentcast.js';
import { extractBuildingColor, mapColorToWall } from '@ui/import-color.js';

// ─── Storage Keys ───────────────────────────────────────────────────────────

const SESSION_PREFIX = 'craftmatic_import_';

/** Save a form value to sessionStorage */
function saveField(key: string, value: string): void {
  try { sessionStorage.setItem(SESSION_PREFIX + key, value); } catch { /* quota */ }
}

/** Load a form value from sessionStorage */
function loadField(key: string): string {
  try { return sessionStorage.getItem(SESSION_PREFIX + key) ?? ''; } catch { return ''; }
}

// ─── Types & Constants ──────────────────────────────────────────────────────

/** Property data collected from the form */
export interface PropertyData {
  address: string;
  stories: number;
  sqft: number;
  bedrooms: number;
  bathrooms: number;
  yearBuilt: number;
  propertyType: string;
  style: StyleName | 'auto';
  floorPlan?: FloorPlanAnalysis;
  geocoding?: GeocodingResult;
  season?: SeasonalWeather;
  newConstruction?: boolean;
  /** Lot size in sqft (from RentCast) */
  lotSize?: number;
  /** Exterior material description (from RentCast) */
  exteriorType?: string;
  /** Wall block override derived from exterior type or satellite color */
  wallOverride?: BlockState;
  /** Roof material description (from RentCast) */
  roofType?: string;
  /** Architecture style description (from RentCast) */
  architectureType?: string;
  /** Detected building color RGB from satellite imagery */
  detectedColor?: { r: number; g: number; b: number };
}

/** Style presets with colors — "Auto" infers from year built */
const STYLE_PRESETS: { value: StyleName | 'auto'; label: string; color: string }[] = [
  { value: 'auto', label: 'Auto', color: '#8888a8' },
  { value: 'fantasy', label: 'Fantasy', color: '#b19cd9' },
  { value: 'medieval', label: 'Medieval', color: '#c9a96e' },
  { value: 'modern', label: 'Modern', color: '#87ceeb' },
  { value: 'gothic', label: 'Gothic', color: '#cc4444' },
  { value: 'rustic', label: 'Rustic', color: '#8b7355' },
  { value: 'steampunk', label: 'Steampunk', color: '#cd7f32' },
  { value: 'elven', label: 'Elven', color: '#7cbb5f' },
  { value: 'desert', label: 'Desert', color: '#deb887' },
  { value: 'underwater', label: 'Underwater', color: '#5f9ea0' },
];

/** Season display labels with emoji-free descriptors */
const SEASON_LABELS: Record<SeasonalWeather, string> = {
  snow: 'Winter',
  spring: 'Spring',
  summer: 'Summer',
  fall: 'Autumn',
};

// ─── Core Logic ─────────────────────────────────────────────────────────────

/** FNV-1a hash for deterministic seed from address string */
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 999999;
}

/** Infer architectural style from year built + new construction flag */
function inferStyle(year: number, newConstruction = false): StyleName {
  if (newConstruction || year >= 2010) return 'modern';
  if (year < 1700) return 'medieval';
  if (year < 1850) return 'gothic';
  if (year < 1920) return 'rustic';
  if (year < 1970) return 'fantasy';
  return 'modern';
}

/** Convert property data into GenerationOptions for the core generator */
export function convertToGenerationOptions(prop: PropertyData): GenerationOptions {
  const style: StyleName = prop.style === 'auto'
    ? inferStyle(prop.yearBuilt, prop.newConstruction)
    : prop.style;

  // Determine structure type
  let type: StructureType = 'house';
  if (prop.propertyType === 'mansion' || prop.sqft > 5000) {
    type = 'castle';
  }

  // Calculate dimensions from sqft
  // sqft / stories → area per floor, 1 block ≈ 1 meter ≈ 10.76 sqft
  const areaPerFloor = prop.sqft / prop.stories / 10.76;
  const aspectRatio = prop.floorPlan?.aspectRatio ?? 1.3;

  let width = Math.round(Math.sqrt(areaPerFloor * aspectRatio));
  let length = Math.round(Math.sqrt(areaPerFloor / aspectRatio));

  // Clamp to reasonable Minecraft dimensions
  width = Math.max(10, Math.min(60, width));
  length = Math.max(10, Math.min(60, length));

  // Build room list
  const rooms: RoomType[] = ['foyer', 'living', 'kitchen', 'dining'];
  for (let i = 0; i < Math.min(prop.bedrooms, 8); i++) rooms.push('bedroom');
  for (let i = 0; i < Math.min(prop.bathrooms, 6); i++) rooms.push('bathroom');

  // Utility rooms for larger homes
  if (prop.sqft > 2500) {
    rooms.push('study', 'laundry', 'mudroom');
  }
  if (prop.sqft > 3500) {
    rooms.push('library', 'sunroom', 'pantry');
  }

  // Force rustic for cabin property type
  const finalStyle: StyleName = prop.propertyType === 'cabin' ? 'rustic' : style;

  return {
    type,
    floors: prop.stories,
    style: finalStyle,
    rooms,
    width,
    length,
    seed: fnv1aHash(prop.address),
    wallOverride: prop.wallOverride,
  };
}

// ─── UI ─────────────────────────────────────────────────────────────────────

/** Initialize the import tab UI */
export function initImport(
  controls: HTMLElement,
  viewer: HTMLElement,
  onGenerate: (grid: BlockGrid, property: PropertyData) => void,
): void {
  let selectedStyle: StyleName | 'auto' = (loadField('style') as StyleName | 'auto') || 'auto';
  let currentFloorPlan: FloorPlanAnalysis | null = null;
  let currentGeocoding: GeocodingResult | null = null;
  let currentSeason: SeasonalWeather | undefined;
  /** Wall override from RentCast exterior type or satellite color extraction */
  let currentWallOverride: BlockState | undefined;
  /** Detected satellite building color RGB */
  let currentDetectedColor: { r: number; g: number; b: number } | undefined;
  /** RentCast enrichment data */
  let currentRentCast: RentCastPropertyData | null = null;

  // Restore API key display state
  const savedParclKey = getParclApiKey();
  const parclKeyMasked = savedParclKey ? '••••' + savedParclKey.slice(-4) : '';
  const savedRentCastKey = getRentCastApiKey();
  const rentCastKeyMasked = savedRentCastKey ? '••••' + savedRentCastKey.slice(-4) : '';

  controls.innerHTML = `
    <div class="section-title">Import from Address</div>

    <!-- API keys (collapsible) -->
    <details class="customize-section" id="import-api-section" ${savedParclKey && savedRentCastKey ? '' : 'open'}>
      <summary class="customize-summary">API Keys</summary>
      <div class="customize-body">
        <!-- Parcl Labs key -->
        <div class="import-api-hint">
          <strong>Parcl Labs</strong> — beds, baths, sqft, year.
          <a href="https://app.parcllabs.com" target="_blank" rel="noopener" style="color:var(--accent);">Get free key</a>
        </div>
        <div class="import-address-row">
          <input id="import-parcl-key" type="password" class="form-input"
            placeholder="Parcl API key" value="${escapeAttr(savedParclKey)}">
          <button id="import-parcl-save" class="btn btn-secondary btn-sm">${savedParclKey ? 'Saved' : 'Save'}</button>
        </div>
        <div id="import-parcl-status" style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">
          ${parclKeyMasked ? `Key stored: ${parclKeyMasked}` : 'No key — manual entry only'}
        </div>
        <!-- RentCast key -->
        <div class="import-api-hint">
          <strong>RentCast</strong> — floors, lot size, exterior, roof, architecture.
          <a href="https://app.rentcast.io" target="_blank" rel="noopener" style="color:var(--accent);">Get free key</a>
        </div>
        <div class="import-address-row">
          <input id="import-rentcast-key" type="password" class="form-input"
            placeholder="RentCast API key" value="${escapeAttr(savedRentCastKey)}">
          <button id="import-rentcast-save" class="btn btn-secondary btn-sm">${savedRentCastKey ? 'Saved' : 'Save'}</button>
        </div>
        <div id="import-rentcast-status" style="font-size:11px;color:var(--text-muted);">
          ${rentCastKeyMasked ? `Key stored: ${rentCastKeyMasked}` : 'No key — satellite color detection used instead'}
        </div>
      </div>
    </details>

    <!-- Address lookup -->
    <div class="form-group">
      <label class="form-label">Property Address</label>
      <div class="import-address-row">
        <input id="import-address" type="text" class="form-input"
          placeholder="123 Main St, City, State ZIP"
          value="${escapeAttr(loadField('address'))}">
        <button id="import-lookup" class="btn btn-secondary btn-sm">Lookup</button>
      </div>
      <div id="import-status" class="import-status" hidden></div>
    </div>

    <!-- Property details form -->
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Stories</label>
        <input id="import-stories" type="number" class="form-input"
          value="${loadField('stories') || '2'}" min="1" max="8">
      </div>
      <div class="form-group">
        <label class="form-label">Sq. Ft.</label>
        <input id="import-sqft" type="number" class="form-input"
          value="${loadField('sqft') || '2000'}" min="400" max="50000">
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Bedrooms</label>
        <input id="import-beds" type="number" class="form-input"
          value="${loadField('beds') || '3'}" min="0" max="20">
      </div>
      <div class="form-group">
        <label class="form-label">Bathrooms</label>
        <input id="import-baths" type="number" class="form-input"
          value="${loadField('baths') || '2'}" min="0" max="15">
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Year Built</label>
        <input id="import-year" type="number" class="form-input"
          value="${loadField('year') || '2000'}" min="1600" max="2030">
      </div>
      <div class="form-group">
        <label class="form-label">Type</label>
        <select id="import-proptype" class="form-select">
          <option value="house" ${loadField('proptype') === 'house' ? 'selected' : ''}>House</option>
          <option value="townhouse" ${loadField('proptype') === 'townhouse' ? 'selected' : ''}>Townhouse</option>
          <option value="condo" ${loadField('proptype') === 'condo' ? 'selected' : ''}>Condo</option>
          <option value="cabin" ${loadField('proptype') === 'cabin' ? 'selected' : ''}>Cabin</option>
          <option value="mansion" ${loadField('proptype') === 'mansion' ? 'selected' : ''}>Mansion</option>
        </select>
      </div>
    </div>

    <!-- Style chips -->
    <div class="form-group">
      <label class="form-label">Style</label>
      <div id="import-style-chips" style="display:flex;gap:6px;flex-wrap:wrap;">
        ${STYLE_PRESETS.map(s => `
          <button class="style-chip ${s.value === selectedStyle ? 'active' : ''}" data-style="${s.value}"
                  style="--chip-color:${s.color};">
            ${s.label}
          </button>
        `).join('')}
      </div>
    </div>

    <!-- Floor plan upload (collapsible) -->
    <details class="customize-section" id="import-floorplan-section">
      <summary class="customize-summary">Floor Plan (Optional)</summary>
      <div class="customize-body">
        <div id="import-floorplan-drop" class="import-floorplan-drop">
          <p style="color:var(--text-muted);font-size:12px;">Drop or paste floor plan image, or click to browse</p>
          <input type="file" id="import-floorplan-input" accept="image/*" hidden>
        </div>
        <div id="import-floorplan-info" style="font-size:11px;color:var(--text-secondary);" hidden></div>
      </div>
    </details>

    <!-- Action buttons -->
    <div class="gen-actions">
      <div class="divider"></div>
      <button id="import-generate" class="btn btn-primary btn-full">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        Import &amp; Generate
      </button>
      <div id="import-info" class="info-panel" hidden></div>
    </div>
  `;

  // ── DOM refs ──────────────────────────────────────────────────────────
  const addressInput = controls.querySelector('#import-address') as HTMLInputElement;
  const lookupBtn = controls.querySelector('#import-lookup') as HTMLButtonElement;
  const statusEl = controls.querySelector('#import-status') as HTMLElement;
  const generateBtn = controls.querySelector('#import-generate') as HTMLButtonElement;
  const infoPanel = controls.querySelector('#import-info') as HTMLElement;
  const floorPlanDrop = controls.querySelector('#import-floorplan-drop') as HTMLElement;
  const floorPlanInput = controls.querySelector('#import-floorplan-input') as HTMLInputElement;
  const floorPlanInfo = controls.querySelector('#import-floorplan-info') as HTMLElement;
  const parclKeyInput = controls.querySelector('#import-parcl-key') as HTMLInputElement;
  const parclSaveBtn = controls.querySelector('#import-parcl-save') as HTMLButtonElement;
  const parclStatus = controls.querySelector('#import-parcl-status') as HTMLElement;
  const rentCastKeyInput = controls.querySelector('#import-rentcast-key') as HTMLInputElement;
  const rentCastSaveBtn = controls.querySelector('#import-rentcast-save') as HTMLButtonElement;
  const rentCastStatus = controls.querySelector('#import-rentcast-status') as HTMLElement;
  const apiSection = controls.querySelector('#import-api-section') as HTMLDetailsElement;

  // Form field refs for persistence
  const fieldIds = ['import-stories', 'import-sqft', 'import-beds', 'import-baths', 'import-year'] as const;
  const fieldKeys = ['stories', 'sqft', 'beds', 'baths', 'year'] as const;

  // ── API Key management ────────────────────────────────────────────────
  // Parcl Labs key
  parclSaveBtn.addEventListener('click', () => {
    const key = parclKeyInput.value.trim();
    setParclApiKey(key);
    if (key) {
      parclSaveBtn.textContent = 'Saved';
      parclStatus.textContent = `Key stored: ••••${key.slice(-4)}`;
    } else {
      parclSaveBtn.textContent = 'Save';
      parclStatus.textContent = 'No key — manual entry only';
    }
    // Auto-close if both keys are set
    if (hasParclApiKey() && hasRentCastApiKey()) apiSection.open = false;
  });
  parclKeyInput.addEventListener('input', () => { parclSaveBtn.textContent = 'Save'; });

  // RentCast key
  rentCastSaveBtn.addEventListener('click', () => {
    const key = rentCastKeyInput.value.trim();
    setRentCastApiKey(key);
    if (key) {
      rentCastSaveBtn.textContent = 'Saved';
      rentCastStatus.textContent = `Key stored: ••••${key.slice(-4)}`;
    } else {
      rentCastSaveBtn.textContent = 'Save';
      rentCastStatus.textContent = 'No key — satellite color detection used instead';
    }
    if (hasParclApiKey() && hasRentCastApiKey()) apiSection.open = false;
  });
  rentCastKeyInput.addEventListener('input', () => { rentCastSaveBtn.textContent = 'Save'; });

  // ── Session persistence for all form fields ───────────────────────────
  // Address field
  addressInput.addEventListener('input', () => saveField('address', addressInput.value));

  // Numeric fields
  for (let i = 0; i < fieldIds.length; i++) {
    const el = controls.querySelector(`#${fieldIds[i]}`) as HTMLInputElement;
    el.addEventListener('input', () => saveField(fieldKeys[i], el.value));
  }

  // Property type select
  const propTypeEl = controls.querySelector('#import-proptype') as HTMLSelectElement;
  propTypeEl.addEventListener('change', () => saveField('proptype', propTypeEl.value));

  // ── Style chips ───────────────────────────────────────────────────────
  const chips = controls.querySelectorAll('.style-chip');
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedStyle = (chip as HTMLElement).dataset['style'] as StyleName | 'auto';
      saveField('style', selectedStyle);
    });
  });

  // ── Address lookup ────────────────────────────────────────────────────
  lookupBtn.addEventListener('click', doLookup);
  addressInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLookup();
  });

  async function doLookup(): Promise<void> {
    const address = addressInput.value.trim();
    if (!address) {
      showStatus('Enter an address to look up', 'error');
      return;
    }

    lookupBtn.disabled = true;

    // Run geocoding, Parcl API, and RentCast lookup in parallel
    showStatus('Looking up property...', 'loading');

    // Reset enrichment state for new lookup
    currentWallOverride = undefined;
    currentDetectedColor = undefined;
    currentRentCast = null;

    const [geoResult, parclResult, rentCastResult] = await Promise.allSettled([
      geocodeAddress(address),
      hasParclApiKey() ? searchParclProperty(address) : Promise.resolve(null),
      hasRentCastApiKey() ? searchRentCastProperty(address) : Promise.resolve(null),
    ]);

    // Handle geocoding result
    if (geoResult.status === 'fulfilled' && geoResult.value) {
      currentGeocoding = geoResult.value;
      const geo = geoResult.value;

      // Show satellite view (async, don't block) — also extract building color
      showSatelliteLoading(viewer);
      composeSatelliteView(geo.lat, geo.lng).then(canvas => {
        currentSeason = (canvas.dataset['season'] as SeasonalWeather) ?? undefined;

        // Extract building color from satellite canvas around crosshair
        // Crosshair position = pixelOffset within center tile + 256
        const { pixelX, pixelY } = getCrosshairPosition(geo.lat, geo.lng);
        const color = extractBuildingColor(canvas, pixelX, pixelY);
        if (color) {
          currentDetectedColor = color;
          // Only use satellite color as wallOverride if RentCast didn't provide exteriorType
          if (!currentWallOverride) {
            currentWallOverride = mapColorToWall(color);
          }
        }

        showSatelliteCanvas(viewer, canvas, geo, currentSeason, currentDetectedColor);
      }).catch(() => {
        showSatelliteError(viewer);
      });
    } else {
      currentGeocoding = null;
      const msg = geoResult.status === 'rejected'
        ? (geoResult.reason instanceof Error ? geoResult.reason.message : 'Geocoding failed')
        : 'No geocoding result';
      showStatus(msg, 'error');
      lookupBtn.disabled = false;
      return;
    }

    // Handle RentCast API result — enriches with floor count, exterior, lot size
    // Process RentCast first so wallOverride from exterior type takes priority
    if (rentCastResult.status === 'fulfilled' && rentCastResult.value) {
      currentRentCast = rentCastResult.value;
      populateFromRentCast(rentCastResult.value);
    }

    // Handle Parcl API result — auto-fill form fields
    const statusParts: string[] = [currentGeocoding!.matchedAddress, `(${currentGeocoding!.source})`];
    if (parclResult.status === 'fulfilled' && parclResult.value) {
      populateFromParcl(parclResult.value);
      statusParts.push('— property data loaded');
    }
    if (currentRentCast) {
      statusParts.push(currentRentCast.exteriorType ? `| ${currentRentCast.exteriorType}` : '');
    }
    showStatus(statusParts.filter(Boolean).join(' '), 'success');

    lookupBtn.disabled = false;
  }

  /** Populate form fields from Parcl Labs property data */
  function populateFromParcl(parcl: ParclPropertyData): void {
    const fieldMap: [string, string, number][] = [
      ['import-sqft', 'sqft', parcl.squareFootage],
      ['import-beds', 'beds', parcl.bedrooms],
      ['import-baths', 'baths', parcl.bathrooms],
      ['import-year', 'year', parcl.yearBuilt],
    ];

    for (const [id, key, value] of fieldMap) {
      if (value && value > 0) {
        const el = controls.querySelector(`#${id}`) as HTMLInputElement;
        el.value = String(value);
        saveField(key, String(value));
        // Brief highlight animation to show auto-filled fields
        el.classList.add('import-field-filled');
        setTimeout(() => el.classList.remove('import-field-filled'), 1500);
      }
    }

    // Stories: estimate from sqft + bedrooms if not directly available
    // Parcl doesn't provide stories directly — infer from sqft
    if (parcl.squareFootage > 2500 && parcl.bedrooms > 3) {
      const storiesEl = controls.querySelector('#import-stories') as HTMLInputElement;
      storiesEl.value = '2';
      saveField('stories', '2');
    }

    // Property type mapping
    if (parcl.propertyType) {
      const mapped = mapParclPropertyType(parcl.propertyType);
      propTypeEl.value = mapped;
      saveField('proptype', mapped);
    }

    // Auto-select style based on year + new construction
    if (parcl.yearBuilt && selectedStyle === 'auto') {
      // Style inference happens at generation time — nothing to select here
      // But if new construction, hint this in the style
    }
  }

  /** Populate form fields and wallOverride from RentCast property data */
  function populateFromRentCast(rc: RentCastPropertyData): void {
    // Floor count → stories field (most reliable source for this)
    if (rc.floorCount && rc.floorCount > 0) {
      const storiesEl = controls.querySelector('#import-stories') as HTMLInputElement;
      storiesEl.value = String(rc.floorCount);
      saveField('stories', String(rc.floorCount));
      storiesEl.classList.add('import-field-filled');
      setTimeout(() => storiesEl.classList.remove('import-field-filled'), 1500);
    }

    // Exterior type → wall material override (highest priority for wallOverride)
    if (rc.exteriorType) {
      const mapped = mapExteriorToWall(rc.exteriorType);
      if (mapped) {
        currentWallOverride = mapped;
      }
    }

    // If RentCast also provides beds/baths/sqft/year and Parcl didn't, backfill
    const backfillMap: [string, string, number][] = [
      ['import-sqft', 'sqft', rc.squareFootage],
      ['import-beds', 'beds', rc.bedrooms],
      ['import-baths', 'baths', rc.bathrooms],
      ['import-year', 'year', rc.yearBuilt],
    ];
    for (const [id, key, value] of backfillMap) {
      if (value && value > 0) {
        const el = controls.querySelector(`#${id}`) as HTMLInputElement;
        // Only backfill if current value is the default
        const current = parseInt(el.value) || 0;
        if (current === 0 || el.value === loadField(key)) continue;
      }
    }
  }

  /** Get crosshair pixel position on the 768x768 satellite canvas */
  function getCrosshairPosition(lat: number, lng: number): { pixelX: number; pixelY: number } {
    // Re-derive from latLngToTile at zoom 18 (same as composeSatelliteView)
    const zoom = 18;
    const n = Math.pow(2, zoom);
    const latRad = (lat * Math.PI) / 180;
    const xFrac = ((lng + 180) / 360) * n;
    const yFrac = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    const tileX = Math.floor(xFrac);
    const tileY = Math.floor(yFrac);
    // Pixel offset within the center tile + 256 (center tile starts at 256,256)
    const pixelX = 256 + Math.floor((xFrac - tileX) * 256);
    const pixelY = 256 + Math.floor((yFrac - tileY) * 256);
    return { pixelX, pixelY };
  }

  function showStatus(message: string, type: 'success' | 'error' | 'loading'): void {
    statusEl.hidden = false;
    statusEl.textContent = message;
    statusEl.className = `import-status import-status-${type}`;
  }

  // ── Satellite view display ────────────────────────────────────────────
  function showSatelliteLoading(container: HTMLElement): void {
    container.innerHTML = `
      <div class="viewer-placeholder">
        <div class="spinner"></div>
        <p>Loading satellite view...</p>
      </div>
    `;
  }

  function showSatelliteError(container: HTMLElement): void {
    container.innerHTML = `
      <div class="viewer-placeholder">
        <p style="color:var(--text-muted);">Satellite imagery unavailable</p>
      </div>
    `;
  }

  function showSatelliteCanvas(
    container: HTMLElement,
    canvas: HTMLCanvasElement,
    geo: GeocodingResult,
    season?: SeasonalWeather,
    detectedColor?: { r: number; g: number; b: number },
  ): void {
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'import-satellite-wrapper';

    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.objectFit = 'contain';
    wrapper.appendChild(canvas);

    // Lat/lng + season + detected color overlay
    const overlay = document.createElement('div');
    overlay.className = 'import-satellite-overlay';
    const seasonLabel = season ? ` | ${SEASON_LABELS[season]}` : '';
    let colorHtml = '';
    if (detectedColor) {
      const hex = `rgb(${detectedColor.r},${detectedColor.g},${detectedColor.b})`;
      colorHtml = ` | <span class="import-color-swatch" style="background:${hex};"></span>`;
    }
    overlay.innerHTML = `${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}${seasonLabel}${colorHtml}`;
    wrapper.appendChild(overlay);

    container.appendChild(wrapper);
  }

  // ── Floor plan: drag, drop, click, and clipboard paste ────────────────
  floorPlanDrop.addEventListener('click', () => floorPlanInput.click());

  floorPlanDrop.addEventListener('dragover', (e) => {
    e.preventDefault();
    floorPlanDrop.classList.add('dragover');
  });

  floorPlanDrop.addEventListener('dragleave', () => {
    floorPlanDrop.classList.remove('dragover');
  });

  floorPlanDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    floorPlanDrop.classList.remove('dragover');
    const file = e.dataTransfer?.files[0];
    if (file && file.type.startsWith('image/')) {
      handleFloorPlanFile(file);
    }
  });

  floorPlanInput.addEventListener('change', () => {
    const file = floorPlanInput.files?.[0];
    if (file) handleFloorPlanFile(file);
    floorPlanInput.value = '';
  });

  // Clipboard paste support — works when floor plan section is open
  document.addEventListener('paste', (e) => {
    // Only handle if import tab is active and floor plan section is open
    const importTab = controls.closest('.tab-content');
    if (!importTab?.classList.contains('active')) return;

    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          // Auto-open floor plan section if closed
          const section = controls.querySelector('#import-floorplan-section') as HTMLDetailsElement;
          section.open = true;
          handleFloorPlanFile(file);
        }
        break;
      }
    }
  });

  function handleFloorPlanFile(file: File): void {
    if (file.size > 10 * 1024 * 1024) {
      floorPlanInfo.hidden = false;
      floorPlanInfo.textContent = 'File too large (max 10MB)';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const analysis = analyzeFloorPlan(img);
        currentFloorPlan = analysis;

        floorPlanInfo.hidden = false;
        floorPlanInfo.textContent = `Detected ${analysis.rooms.length} room${analysis.rooms.length !== 1 ? 's' : ''} | Aspect ratio: ${analysis.aspectRatio.toFixed(2)}:1 | ${analysis.imageWidth}x${analysis.imageHeight}px`;

        // Show loaded state with filename (or "pasted image")
        const name = file.name || 'Pasted image';
        floorPlanDrop.innerHTML = `<p style="color:var(--success);font-size:12px;">Floor plan loaded: ${escapeHtml(name)}</p>`;
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }

  // ── Generate ──────────────────────────────────────────────────────────
  generateBtn.addEventListener('click', doGenerate);

  function doGenerate(): void {
    const yearVal = parseInt((controls.querySelector('#import-year') as HTMLInputElement).value) || 2000;

    const property: PropertyData = {
      address: addressInput.value.trim() || 'Unknown Address',
      stories: parseInt((controls.querySelector('#import-stories') as HTMLInputElement).value) || 2,
      sqft: parseInt((controls.querySelector('#import-sqft') as HTMLInputElement).value) || 2000,
      bedrooms: parseInt((controls.querySelector('#import-beds') as HTMLInputElement).value) || 3,
      bathrooms: parseInt((controls.querySelector('#import-baths') as HTMLInputElement).value) || 2,
      yearBuilt: yearVal,
      propertyType: propTypeEl.value,
      style: selectedStyle,
      floorPlan: currentFloorPlan ?? undefined,
      geocoding: currentGeocoding ?? undefined,
      season: currentSeason,
      newConstruction: yearVal >= 2020,
      lotSize: currentRentCast?.lotSize,
      exteriorType: currentRentCast?.exteriorType,
      wallOverride: currentWallOverride,
      roofType: currentRentCast?.roofType,
      architectureType: currentRentCast?.architectureType,
      detectedColor: currentDetectedColor,
    };

    const options = convertToGenerationOptions(property);
    const grid = generateStructure(options);

    // Show info panel with enrichment data
    const nonAir = grid.countNonAir();
    const seasonStr = property.season ? ` | ${SEASON_LABELS[property.season]}` : '';
    const constructionStr = property.newConstruction ? ' (new)' : '';

    // Build optional enrichment rows
    let enrichmentRows = '';
    if (property.lotSize && property.lotSize > 0) {
      enrichmentRows += `<div class="info-row"><span class="info-label">Lot Size</span><span class="info-value">${property.lotSize.toLocaleString()} sqft</span></div>`;
    }
    if (property.exteriorType) {
      enrichmentRows += `<div class="info-row"><span class="info-label">Exterior</span><span class="info-value">${escapeHtml(property.exteriorType)}</span></div>`;
    }
    if (property.detectedColor) {
      const c = property.detectedColor;
      const hex = `rgb(${c.r},${c.g},${c.b})`;
      enrichmentRows += `<div class="info-row"><span class="info-label">Detected Color</span><span class="info-value"><span class="import-color-swatch" style="background:${hex};"></span> ${c.r},${c.g},${c.b}</span></div>`;
    }
    if (property.wallOverride) {
      // Show the mapped wall block name (strip minecraft: prefix)
      const wallName = property.wallOverride.replace('minecraft:', '').replace(/_/g, ' ');
      enrichmentRows += `<div class="info-row"><span class="info-label">Wall Material</span><span class="info-value">${wallName}</span></div>`;
    }
    if (property.roofType) {
      enrichmentRows += `<div class="info-row"><span class="info-label">Roof</span><span class="info-value">${escapeHtml(property.roofType)}</span></div>`;
    }
    if (property.architectureType) {
      enrichmentRows += `<div class="info-row"><span class="info-label">Architecture</span><span class="info-value">${escapeHtml(property.architectureType)}</span></div>`;
    }

    infoPanel.hidden = false;
    infoPanel.innerHTML = `
      <div class="info-row"><span class="info-label">Address</span><span class="info-value" style="font-family:var(--font);font-size:11px;">${escapeHtml(property.address)}</span></div>
      <div class="info-row"><span class="info-label">Dimensions</span><span class="info-value">${grid.width} x ${grid.height} x ${grid.length}</span></div>
      <div class="info-row"><span class="info-label">Blocks</span><span class="info-value">${nonAir.toLocaleString()}</span></div>
      <div class="info-row"><span class="info-label">Style</span><span class="info-value">${options.style}${constructionStr}${seasonStr}</span></div>
      <div class="info-row"><span class="info-label">Rooms</span><span class="info-value">${options.rooms?.length ?? 0}</span></div>
      ${enrichmentRows}
    `;

    onGenerate(grid, property);
  }
}

/** Escape HTML to prevent XSS in address display */
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escape for HTML attribute values */
function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
