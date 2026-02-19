/**
 * Import tab — address-to-structure generation.
 * Takes a real estate address, geocodes it, fetches property data via Parcl Labs API,
 * shows satellite imagery with seasonal weather overlay, accepts property details,
 * and generates a Minecraft structure.
 */

import type { StyleName, BlockState } from '@craft/types/index.js';
import {
  convertToGenerationOptions, estimateStoriesFromFootprint,
  type PropertyData,
} from '@craft/gen/address-pipeline.js';
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
import { extractBuildingColor, mapColorToWall, detectPool } from '@ui/import-color.js';
import {
  searchOSMBuilding, mapOSMMaterialToWall, mapOSMRoofShape,
  analyzePolygonShape, type OSMBuildingData,
} from '@ui/import-osm.js';
import {
  getStreetViewApiKey, setStreetViewApiKey, hasStreetViewApiKey,
  getStreetViewUrl, checkStreetViewAvailability, STREETVIEW_SIGNUP_URL,
} from '@ui/import-streetview.js';
import {
  getMapboxToken, setMapboxToken, hasMapboxToken,
  createMapboxTileFetcher, MAPBOX_SIGNUP_URL,
} from '@ui/import-mapbox.js';
import {
  drawBuildingOutline, getCrosshairPosition, appendStreetViewImage,
} from '@ui/import-geometry.js';
import { buildInfoPanelHtml, escapeHtml } from '@ui/import-info-panel.js';

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

// PropertyData, convertToGenerationOptions, and inference functions are
// imported from @craft/gen/address-pipeline.js (shared with CLI)
export { convertToGenerationOptions } from '@craft/gen/address-pipeline.js';
export type { PropertyData } from '@craft/gen/address-pipeline.js';

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
  /** Wall override from RentCast exterior type, OSM material, or satellite color */
  let currentWallOverride: BlockState | undefined;
  /** Detected satellite building color RGB */
  let currentDetectedColor: { r: number; g: number; b: number } | undefined;
  /** RentCast enrichment data */
  let currentRentCast: RentCastPropertyData | null = null;
  /** OSM building footprint data */
  let currentOSM: OSMBuildingData | null = null;
  /** Whether a pool was detected from satellite imagery */
  let currentPoolDetected = false;
  /** Street View image URL (if available) */
  let currentStreetViewUrl: string | null = null;
  /** Parcl Labs property data — stored for generation-time access */
  let currentParcl: ParclPropertyData | null = null;

  // Restore API key display state
  const savedParclKey = getParclApiKey();
  const parclKeyMasked = savedParclKey ? '••••' + savedParclKey.slice(-4) : '';
  const savedRentCastKey = getRentCastApiKey();
  const rentCastKeyMasked = savedRentCastKey ? '••••' + savedRentCastKey.slice(-4) : '';
  const savedStreetViewKey = getStreetViewApiKey();
  const svKeyMasked = savedStreetViewKey ? '••••' + savedStreetViewKey.slice(-4) : '';
  const savedMapboxToken = getMapboxToken();
  const mbTokenMasked = savedMapboxToken ? '••••' + savedMapboxToken.slice(-4) : '';

  controls.innerHTML = `
    <div class="section-title">Import from Address</div>

    <!-- API keys (collapsible, defaults closed — expand via button) -->
    <details class="customize-section" id="import-api-section">
      <summary class="customize-summary">API Keys
        <span class="import-api-badge" id="import-api-badge">${
          [savedParclKey, savedRentCastKey, savedStreetViewKey, savedMapboxToken].filter(Boolean).length
        }/4</span>
      </summary>
      <div class="customize-body import-api-list">
        <!-- Parcl Labs key -->
        <div class="import-api-row">
          <div class="import-api-label">
            <strong>Parcl Labs</strong>
            <span class="import-api-desc">beds, baths, sqft, year</span>
          </div>
          <div class="import-api-input-row">
            <input id="import-parcl-key" type="password" class="form-input import-api-key-input"
              placeholder="Paste API key" value="${escapeAttr(savedParclKey)}">
            <button id="import-parcl-save" class="btn btn-secondary btn-sm">${savedParclKey ? 'Saved' : 'Save'}</button>
            <a href="https://app.parcllabs.com" target="_blank" rel="noopener"
              class="import-api-link" title="Get free key">Get key</a>
          </div>
          <div id="import-parcl-status" class="import-api-status">
            ${parclKeyMasked ? `Key stored: ${parclKeyMasked}` : 'No key — manual entry only'}
          </div>
        </div>
        <!-- RentCast key -->
        <div class="import-api-row">
          <div class="import-api-label">
            <strong>RentCast</strong>
            <span class="import-api-desc">floors, lot size, exterior, roof</span>
          </div>
          <div class="import-api-input-row">
            <input id="import-rentcast-key" type="password" class="form-input import-api-key-input"
              placeholder="Paste API key" value="${escapeAttr(savedRentCastKey)}">
            <button id="import-rentcast-save" class="btn btn-secondary btn-sm">${savedRentCastKey ? 'Saved' : 'Save'}</button>
            <a href="https://app.rentcast.io" target="_blank" rel="noopener"
              class="import-api-link" title="Get free key">Get key</a>
          </div>
          <div id="import-rentcast-status" class="import-api-status">
            ${rentCastKeyMasked ? `Key stored: ${rentCastKeyMasked}` : 'No key — satellite color used instead'}
          </div>
        </div>
        <!-- Google Street View key -->
        <div class="import-api-row">
          <div class="import-api-label">
            <strong>Street View</strong>
            <span class="import-api-desc">exterior property photo</span>
          </div>
          <div class="import-api-input-row">
            <input id="import-sv-key" type="password" class="form-input import-api-key-input"
              placeholder="Paste API key" value="${escapeAttr(savedStreetViewKey)}">
            <button id="import-sv-save" class="btn btn-secondary btn-sm">${savedStreetViewKey ? 'Saved' : 'Save'}</button>
            <a href="${STREETVIEW_SIGNUP_URL}" target="_blank" rel="noopener"
              class="import-api-link" title="Get free key">Get key</a>
          </div>
          <div id="import-sv-status" class="import-api-status">
            ${svKeyMasked ? `Key stored: ${svKeyMasked}` : 'No key — no exterior photo'}
          </div>
        </div>
        <!-- Mapbox token -->
        <div class="import-api-row">
          <div class="import-api-label">
            <strong>Mapbox</strong>
            <span class="import-api-desc">high-res satellite (30cm)</span>
          </div>
          <div class="import-api-input-row">
            <input id="import-mb-token" type="password" class="form-input import-api-key-input"
              placeholder="Paste access token" value="${escapeAttr(savedMapboxToken)}">
            <button id="import-mb-save" class="btn btn-secondary btn-sm">${savedMapboxToken ? 'Saved' : 'Save'}</button>
            <a href="${MAPBOX_SIGNUP_URL}" target="_blank" rel="noopener"
              class="import-api-link" title="Get free token">Get token</a>
          </div>
          <div id="import-mb-status" class="import-api-status">
            ${mbTokenMasked ? `Token stored: ${mbTokenMasked}` : 'No token — using ESRI satellite'}
          </div>
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
          value="${loadField('stories') || '2'}" min="1" max="100">
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
  const svKeyInput = controls.querySelector('#import-sv-key') as HTMLInputElement;
  const svSaveBtn = controls.querySelector('#import-sv-save') as HTMLButtonElement;
  const svStatus = controls.querySelector('#import-sv-status') as HTMLElement;
  const mbTokenInput = controls.querySelector('#import-mb-token') as HTMLInputElement;
  const mbSaveBtn = controls.querySelector('#import-mb-save') as HTMLButtonElement;
  const mbStatus = controls.querySelector('#import-mb-status') as HTMLElement;
  const apiSection = controls.querySelector('#import-api-section') as HTMLDetailsElement;

  // Form field refs for persistence
  const fieldIds = ['import-stories', 'import-sqft', 'import-beds', 'import-baths', 'import-year'] as const;
  const fieldKeys = ['stories', 'sqft', 'beds', 'baths', 'year'] as const;

  // ── API Key management ────────────────────────────────────────────────
  const apiBadge = controls.querySelector('#import-api-badge') as HTMLElement;

  /** Update the N/4 badge count after any key save */
  function updateApiBadge(): void {
    const count = [hasParclApiKey(), hasRentCastApiKey(), hasStreetViewApiKey(), hasMapboxToken()]
      .filter(Boolean).length;
    apiBadge.textContent = `${count}/4`;
  }

  // Data-driven API key save handlers — DRY replacement for 4 identical patterns
  const apiKeyConfigs = [
    { input: parclKeyInput, btn: parclSaveBtn, status: parclStatus,
      set: setParclApiKey, noKeyMsg: 'No key — manual entry only' },
    { input: rentCastKeyInput, btn: rentCastSaveBtn, status: rentCastStatus,
      set: setRentCastApiKey, noKeyMsg: 'No key — satellite color used instead' },
    { input: svKeyInput, btn: svSaveBtn, status: svStatus,
      set: setStreetViewApiKey, noKeyMsg: 'No key — no exterior photo' },
    { input: mbTokenInput, btn: mbSaveBtn, status: mbStatus,
      set: setMapboxToken, noKeyMsg: 'No token — using ESRI satellite' },
  ];

  for (const cfg of apiKeyConfigs) {
    cfg.btn.addEventListener('click', () => {
      const key = cfg.input.value.trim();
      cfg.set(key);
      cfg.btn.textContent = key ? 'Saved' : 'Save';
      cfg.status.textContent = key ? `Key stored: ••••${key.slice(-4)}` : cfg.noKeyMsg;
      updateApiBadge();
    });
    cfg.input.addEventListener('input', () => { cfg.btn.textContent = 'Save'; });
  }

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
    currentOSM = null;
    currentPoolDetected = false;
    currentStreetViewUrl = null;
    currentParcl = null;

    const [geoResult, parclResult, rentCastResult] = await Promise.allSettled([
      geocodeAddress(address),
      hasParclApiKey() ? searchParclProperty(address) : Promise.resolve(null),
      hasRentCastApiKey() ? searchRentCastProperty(address) : Promise.resolve(null),
    ]);

    // Handle geocoding result — fall back to Parcl lat/lng if geocoders fail
    let parclGeoFallback = false;
    if (geoResult.status !== 'fulfilled' || !geoResult.value) {
      // Check if Parcl returned valid coordinates as geocoding fallback
      const parclData = parclResult.status === 'fulfilled' ? parclResult.value : null;
      if (parclData && parclData.latitude !== 0 && parclData.longitude !== 0) {
        currentGeocoding = {
          lat: parclData.latitude,
          lng: parclData.longitude,
          matchedAddress: parclData.address || address,
          source: 'nominatim', // closest match — Parcl uses address matching
        };
        parclGeoFallback = true;
      }
    } else {
      currentGeocoding = geoResult.value;
    }

    if (currentGeocoding) {
      const geo = currentGeocoding;

      // Fire OSM + Street View checks in parallel (don't block satellite)
      const [osmResult, svResult] = await Promise.allSettled([
        searchOSMBuilding(geo.lat, geo.lng),
        hasStreetViewApiKey()
          ? checkStreetViewAvailability(geo.lat, geo.lng, getStreetViewApiKey())
          : Promise.resolve(false),
      ]);

      // Process OSM result
      if (osmResult.status === 'fulfilled' && osmResult.value) {
        currentOSM = osmResult.value;
      }

      // Process Street View result
      if (svResult.status === 'fulfilled' && svResult.value === true) {
        currentStreetViewUrl = getStreetViewUrl(geo.lat, geo.lng, getStreetViewApiKey());
      }

      // Build Mapbox tile fetcher if token is configured
      const tileFetcher = hasMapboxToken()
        ? createMapboxTileFetcher(getMapboxToken())
        : undefined;

      // Show satellite view (async, don't block) — also extract building color
      showSatelliteLoading(viewer);
      composeSatelliteView(geo.lat, geo.lng, 18, tileFetcher).then(canvas => {
        currentSeason = (canvas.dataset['season'] as SeasonalWeather) ?? undefined;

        // Extract building color from satellite canvas around crosshair
        const { pixelX, pixelY } = getCrosshairPosition(geo.lat, geo.lng);
        const color = extractBuildingColor(canvas, pixelX, pixelY);
        if (color) {
          currentDetectedColor = color;
          // Only use satellite color as wallOverride if higher-priority sources didn't set it
          if (!currentWallOverride) {
            currentWallOverride = mapColorToWall(color);
          }
        }

        // Pool detection — scan ring around building for cyan/blue pixels
        currentPoolDetected = detectPool(canvas, pixelX, pixelY);

        // Draw OSM building polygon overlay on satellite canvas
        if (currentOSM && currentOSM.polygon.length >= 3) {
          drawBuildingOutline(canvas, geo, currentOSM.polygon);
        }

        showSatelliteCanvas(viewer, canvas, geo, currentSeason, currentDetectedColor);

        // Append Street View image below satellite if available
        if (currentStreetViewUrl) {
          appendStreetViewImage(viewer, currentStreetViewUrl);
        }
      }).catch(() => {
        showSatelliteError(viewer);
      });
    } else {
      // No geocoding and no Parcl fallback — abort
      currentGeocoding = null;
      const msg = geoResult.status === 'rejected'
        ? (geoResult.reason instanceof Error ? geoResult.reason.message : 'Geocoding failed')
        : 'No geocoding result';
      showStatus(msg, 'error');
      lookupBtn.disabled = false;
      return;
    }

    // Handle RentCast API result — enriches with floor count, exterior, lot size
    // Process RentCast first so wallOverride from exterior type takes priority (priority 1)
    if (rentCastResult.status === 'fulfilled' && rentCastResult.value) {
      currentRentCast = rentCastResult.value;
      populateFromRentCast(rentCastResult.value);
    }

    // Handle OSM enrichment — wallOverride priority 2 (below RentCast, above satellite color)
    if (currentOSM) {
      populateFromOSM(currentOSM);
    }

    // Handle Parcl API result — auto-fill form fields
    const geoSource = parclGeoFallback ? 'parcl' : currentGeocoding!.source;
    const statusParts: string[] = [currentGeocoding!.matchedAddress, `(${geoSource})`];
    if (parclResult.status === 'fulfilled' && parclResult.value) {
      currentParcl = parclResult.value;
      populateFromParcl(parclResult.value);
      statusParts.push('— property data loaded');
    }
    if (currentRentCast) {
      statusParts.push(currentRentCast.exteriorType ? `| ${currentRentCast.exteriorType}` : '');
    }
    if (currentOSM) {
      statusParts.push(`| ${currentOSM.widthMeters}m × ${currentOSM.lengthMeters}m (OSM)`);
    }
    showStatus(statusParts.filter(Boolean).join(' '), 'success');

    lookupBtn.disabled = false;
  }

  /** Populate form fields from Parcl Labs property data */
  /** Track whether yearBuilt or bedrooms came from uncertain data */
  let yearUncertain = false;
  let bedroomsUncertain = false;

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
        el.classList.add('import-field-filled');
        setTimeout(() => el.classList.remove('import-field-filled'), 1500);
      }
    }

    // ── yearBuilt=0 handling ──
    // Parcl sometimes returns 0 when data is missing — mark uncertain and
    // default to 2000 (will be overridden by OSM start_date if available)
    if (!parcl.yearBuilt || parcl.yearBuilt === 0) {
      yearUncertain = true;
      const yearEl = controls.querySelector('#import-year') as HTMLInputElement;
      yearEl.value = '2000';
      saveField('year', '2000');
      yearEl.classList.add('import-field-uncertain');
    }

    // ── bedrooms=0 disambiguation ──
    // 0 bedrooms: studio (sqft<800 or condo type) vs missing data
    if (parcl.bedrooms === 0) {
      const pType = (parcl.propertyType || '').toUpperCase();
      const isStudio = parcl.squareFootage < 800
        || pType.includes('CONDO') || pType.includes('STUDIO');
      if (!isStudio) {
        // Likely missing data — default to 3 and mark uncertain
        bedroomsUncertain = true;
        const bedsEl = controls.querySelector('#import-beds') as HTMLInputElement;
        bedsEl.value = '3';
        saveField('beds', '3');
        bedsEl.classList.add('import-field-uncertain');
      }
      // else: real studio, keep bedrooms=0
    }

    // Stories: estimate from sqft + bedrooms + property type
    // Parcl doesn't provide stories directly — use heuristics:
    //   - Condos/townhouses often multi-story regardless of sqft
    //   - Large single-family homes (>2500sqft with >3 beds) likely 2+
    //   - Very large (>4000sqft) likely 3+
    const storiesEl = controls.querySelector('#import-stories') as HTMLInputElement;
    const pType = (parcl.propertyType || '').toUpperCase();
    if (pType.includes('TOWN') || (parcl.squareFootage > 2500 && parcl.bedrooms > 3)) {
      const estimatedStories = parcl.squareFootage > 4000 ? 3 : 2;
      storiesEl.value = String(estimatedStories);
      saveField('stories', String(estimatedStories));
    }

    // Property type mapping
    if (parcl.propertyType) {
      const mapped = mapParclPropertyType(parcl.propertyType);
      propTypeEl.value = mapped;
      saveField('proptype', mapped);
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

  /** Populate form fields and wallOverride from OSM building data */
  function populateFromOSM(osm: OSMBuildingData): void {
    const storiesEl = controls.querySelector('#import-stories') as HTMLInputElement;

    // Stories priority: RentCast floorCount (already set) > OSM levels > footprint calc
    if (!currentRentCast?.floorCount) {
      if (osm.levels && osm.levels > 0) {
        // OSM building:levels tag — second most reliable source
        storiesEl.value = String(osm.levels);
        saveField('stories', String(osm.levels));
        storiesEl.classList.add('import-field-filled');
        setTimeout(() => storiesEl.classList.remove('import-field-filled'), 1500);
      } else if (osm.widthMeters > 0 && osm.lengthMeters > 0) {
        // Footprint-based estimation: total sqft / footprint area
        const sqft = parseInt((controls.querySelector('#import-sqft') as HTMLInputElement).value) || 0;
        if (sqft > 0) {
          const estimated = estimateStoriesFromFootprint(sqft, osm.widthMeters, osm.lengthMeters);
          storiesEl.value = String(estimated);
          saveField('stories', String(estimated));
          storiesEl.classList.add('import-field-filled');
          setTimeout(() => storiesEl.classList.remove('import-field-filled'), 1500);
        }
      }
    }

    // yearBuilt fallback: if Parcl returned 0, try OSM start_date / building:start_date
    const yearEl = controls.querySelector('#import-year') as HTMLInputElement;
    const currentYear = parseInt(yearEl.value) || 0;
    if (currentYear === 0 || currentYear === 2000) {
      const startDate = osm.tags['start_date'] || osm.tags['building:start_date'];
      if (startDate) {
        const parsed = parseInt(startDate, 10);
        if (parsed > 1600 && parsed < 2100) {
          yearEl.value = String(parsed);
          saveField('year', String(parsed));
          yearEl.classList.add('import-field-filled');
          setTimeout(() => yearEl.classList.remove('import-field-filled'), 1500);
        }
      }
    }

    // Wall material from OSM — priority 2 (below RentCast exteriorType, above satellite color)
    if (osm.material && !currentWallOverride) {
      const mapped = mapOSMMaterialToWall(osm.material);
      if (mapped) {
        currentWallOverride = mapped;
      }
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
      newConstruction: currentParcl?.newConstruction ?? yearVal >= 2020,
      lotSize: currentRentCast?.lotSize,
      exteriorType: currentRentCast?.exteriorType,
      wallOverride: currentWallOverride,
      roofType: currentRentCast?.roofType,
      architectureType: currentRentCast?.architectureType,
      detectedColor: currentDetectedColor,
      osmWidth: currentOSM?.widthBlocks,
      osmLength: currentOSM?.lengthBlocks,
      osmLevels: currentOSM?.levels,
      osmMaterial: currentOSM?.material,
      osmRoofShape: currentOSM?.roofShape ? mapOSMRoofShape(currentOSM.roofShape) : undefined,
      osmRoofMaterial: currentOSM?.roofMaterial,
      osmRoofColour: currentOSM?.roofColour,
      osmBuildingColour: currentOSM?.buildingColour,
      osmArchitecture: currentOSM?.tags?.['building:architecture'],
      hasGarage: currentRentCast?.garageSpaces != null && currentRentCast.garageSpaces > 0,
      hasPool: currentPoolDetected,
      floorPlanShape: currentOSM?.polygon
        ? analyzePolygonShape(currentOSM.polygon) : undefined,
      streetViewUrl: currentStreetViewUrl ?? undefined,
      county: currentParcl?.county,
      stateAbbreviation: currentParcl?.stateAbbreviation,
      city: currentParcl?.city,
      zipCode: currentParcl?.zipCode,
      ownerOccupied: currentParcl?.ownerOccupied,
      onMarket: currentParcl?.onMarket,
      parclPropertyId: currentParcl?.parclPropertyId,
      yearUncertain,
      bedroomsUncertain,
    };

    const options = convertToGenerationOptions(property);
    const grid = generateStructure(options);

    // Show info panel with enrichment data
    infoPanel.hidden = false;
    infoPanel.innerHTML = buildInfoPanelHtml(grid, property, options, currentOSM);

    onGenerate(grid, property);
  }
}

/** Escape for HTML attribute values */
function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
