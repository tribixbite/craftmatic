/**
 * Import tab — address-to-structure generation.
 * Takes a real estate address, geocodes it, fetches property data via Parcl Labs API,
 * shows satellite imagery with seasonal weather overlay, accepts property details,
 * and generates a Minecraft structure.
 */

import type { StructureType, StyleName, RoomType } from '@craft/types/index.js';
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

  // Restore API key display state
  const savedKey = getParclApiKey();
  const keyMasked = savedKey ? '••••' + savedKey.slice(-4) : '';

  controls.innerHTML = `
    <div class="section-title">Import from Address</div>

    <!-- Parcl API key (collapsible) -->
    <details class="customize-section" id="import-api-section" ${savedKey ? '' : 'open'}>
      <summary class="customize-summary">Parcl Labs API Key</summary>
      <div class="customize-body">
        <div class="import-api-hint">
          Auto-fill beds, baths, sqft, and year from real property records.
          <a href="https://app.parcllabs.com" target="_blank" rel="noopener" style="color:var(--accent);">Get free key</a>
        </div>
        <div class="import-address-row">
          <input id="import-api-key" type="password" class="form-input"
            placeholder="Paste API key" value="${escapeAttr(savedKey)}">
          <button id="import-api-save" class="btn btn-secondary btn-sm">${savedKey ? 'Saved' : 'Save'}</button>
        </div>
        <div id="import-api-status" style="font-size:11px;color:var(--text-muted);">
          ${keyMasked ? `Key stored: ${keyMasked}` : 'No key configured — form fields are manual entry'}
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
  const apiKeyInput = controls.querySelector('#import-api-key') as HTMLInputElement;
  const apiSaveBtn = controls.querySelector('#import-api-save') as HTMLButtonElement;
  const apiStatus = controls.querySelector('#import-api-status') as HTMLElement;
  const apiSection = controls.querySelector('#import-api-section') as HTMLDetailsElement;

  // Form field refs for persistence
  const fieldIds = ['import-stories', 'import-sqft', 'import-beds', 'import-baths', 'import-year'] as const;
  const fieldKeys = ['stories', 'sqft', 'beds', 'baths', 'year'] as const;

  // ── API Key management ────────────────────────────────────────────────
  apiSaveBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    setParclApiKey(key);
    if (key) {
      apiSaveBtn.textContent = 'Saved';
      apiStatus.textContent = `Key stored: ••••${key.slice(-4)}`;
      apiSection.open = false;
    } else {
      apiSaveBtn.textContent = 'Save';
      apiStatus.textContent = 'No key configured — form fields are manual entry';
    }
  });

  apiKeyInput.addEventListener('input', () => {
    apiSaveBtn.textContent = 'Save';
  });

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

    // Run geocoding and Parcl API lookup in parallel
    showStatus('Looking up property...', 'loading');

    const [geoResult, parclResult] = await Promise.allSettled([
      geocodeAddress(address),
      hasParclApiKey() ? searchParclProperty(address) : Promise.resolve(null),
    ]);

    // Handle geocoding result
    if (geoResult.status === 'fulfilled' && geoResult.value) {
      currentGeocoding = geoResult.value;
      const geo = geoResult.value;

      // Show satellite view (async, don't block)
      showSatelliteLoading(viewer);
      composeSatelliteView(geo.lat, geo.lng).then(canvas => {
        currentSeason = (canvas.dataset['season'] as SeasonalWeather) ?? undefined;
        showSatelliteCanvas(viewer, canvas, geo, currentSeason);
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

    // Handle Parcl API result — auto-fill form fields
    if (parclResult.status === 'fulfilled' && parclResult.value) {
      const parcl = parclResult.value;
      populateFromParcl(parcl);
      const source = currentGeocoding!.source;
      showStatus(`${currentGeocoding!.matchedAddress} (${source}) — property data loaded`, 'success');
    } else {
      showStatus(`${currentGeocoding!.matchedAddress} (${currentGeocoding!.source})`, 'success');
    }

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
  ): void {
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'import-satellite-wrapper';

    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.objectFit = 'contain';
    wrapper.appendChild(canvas);

    // Lat/lng + season overlay
    const overlay = document.createElement('div');
    overlay.className = 'import-satellite-overlay';
    const seasonLabel = season ? ` | ${SEASON_LABELS[season]}` : '';
    overlay.textContent = `${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}${seasonLabel}`;
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
    };

    const options = convertToGenerationOptions(property);
    const grid = generateStructure(options);

    // Show info panel
    const nonAir = grid.countNonAir();
    const seasonStr = property.season ? ` | ${SEASON_LABELS[property.season]}` : '';
    const constructionStr = property.newConstruction ? ' (new)' : '';
    infoPanel.hidden = false;
    infoPanel.innerHTML = `
      <div class="info-row"><span class="info-label">Address</span><span class="info-value" style="font-family:var(--font);font-size:11px;">${escapeHtml(property.address)}</span></div>
      <div class="info-row"><span class="info-label">Dimensions</span><span class="info-value">${grid.width} x ${grid.height} x ${grid.length}</span></div>
      <div class="info-row"><span class="info-label">Blocks</span><span class="info-value">${nonAir.toLocaleString()}</span></div>
      <div class="info-row"><span class="info-label">Style</span><span class="info-value">${options.style}${constructionStr}${seasonStr}</span></div>
      <div class="info-row"><span class="info-label">Rooms</span><span class="info-value">${options.rooms?.length ?? 0}</span></div>
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
