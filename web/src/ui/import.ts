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
  searchSmartyProperty, getSmartyKey, setSmartyKey, hasSmartyKey, hasCustomSmartyKey,
  mapSmartyExteriorToWall, type SmartyPropertyData,
} from '@ui/import-smarty.js';
import { extractBuildingColor, mapColorToWall, detectPool } from '@ui/import-color.js';
import {
  searchOSMBuilding, mapOSMMaterialToWall, mapOSMRoofShape,
  analyzePolygonShape, type OSMBuildingData,
} from '@ui/import-osm.js';
import {
  getStreetViewApiKey, setStreetViewApiKey, hasStreetViewApiKey,
  getStreetViewUrl, fetchStreetViewMetadata, STREETVIEW_SIGNUP_URL,
  type StreetViewMetadata,
} from '@ui/import-streetview.js';
import {
  getMapboxToken, setMapboxToken, hasMapboxToken,
  createMapboxTileFetcher, MAPBOX_SIGNUP_URL,
} from '@ui/import-mapbox.js';
import {
  drawBuildingOutline, getCrosshairPosition, appendStreetViewImage,
} from '@ui/import-geometry.js';
import { buildInfoPanelHtml, escapeHtml } from '@ui/import-info-panel.js';
import {
  extractFootprint, drawFootprintOverlay, type FootprintResult,
} from '@ui/import-satellite-footprint.js';
import {
  getMapillaryMlyToken, setMapillaryMlyToken, hasMapillaryMlyToken,
  searchMapillaryImages, searchMapillaryFeatures,
  pickBestImage, analyzeFeatures, MAPILLARY_SIGNUP_URL,
  type MapillaryImageData, type MapillaryFeatureData,
} from '@ui/import-mapillary.js';
import { analyzeStreetViewBrowser, type BrowserSvColorResult } from '@ui/import-sv-analysis.js';
import { queryMapboxBuildingHeight, type MapboxBuildingResult } from '@ui/import-mapbox-building.js';
import { querySolarBuildingInsights, type SolarBuildingData } from '@craft/gen/api/google-solar.js';
import { fetchElevationGrid, footprintSlope, type ElevationGrid } from '@ui/import-elevation.js';
import { queryNlcdCanopy, type NlcdCanopyResult } from '@ui/import-nlcd.js';
import { queryHardinessZone, type HardinessResult } from '@ui/import-hardiness.js';
import { searchOSMTrees, type OSMTreeData } from '@ui/import-osm-trees.js';
import { queryOvertureBuilding, type OvertureBuildingData } from '@ui/import-overture.js';
import { searchWaterFeatures, type WaterFeature } from '@ui/import-water.js';
import { queryCanopyHeight, type CanopyHeightResult } from '@ui/import-canopy-height.js';
import { queryLandCover, type LandCoverResult } from '@ui/import-landcover.js';

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

/** Style presets — "Auto" uses data-driven materials from observed colors/OSM/assessor;
 *  selecting a named style forces that fantasy preset instead */
const STYLE_PRESETS: { value: StyleName | 'auto'; label: string; color: string }[] = [
  { value: 'auto', label: 'Real', color: '#6a9f6a' },
  { value: 'colonial', label: 'Colonial', color: '#f5f0e1' },
  { value: 'modern', label: 'Modern', color: '#87ceeb' },
  { value: 'rustic', label: 'Rustic', color: '#8b7355' },
  { value: 'desert', label: 'Desert', color: '#deb887' },
  { value: 'gothic', label: 'Gothic', color: '#cc4444' },
  { value: 'fantasy', label: 'Fantasy', color: '#b19cd9' },
  { value: 'medieval', label: 'Medieval', color: '#c9a96e' },
  { value: 'steampunk', label: 'Steampunk', color: '#cd7f32' },
  { value: 'elven', label: 'Elven', color: '#7cbb5f' },
  { value: 'underwater', label: 'Underwater', color: '#5f9ea0' },
];

/** Season display labels with emoji-free descriptors */
const SEASON_LABELS: Record<SeasonalWeather, string> = {
  snow: 'Winter',
  spring: 'Spring',
  summer: 'Summer',
  fall: 'Autumn',
};


/** Compute compass bearing (0-360°) from point A → point B (Haversine forward azimuth) */
function computeBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLng = (lng2 - lng1) * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad)
          - Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
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
  /** Wall override from Smarty exterior type, OSM material, or satellite color */
  let currentWallOverride: BlockState | undefined;
  /** Detected satellite building color RGB */
  let currentDetectedColor: { r: number; g: number; b: number } | undefined;
  /** Smarty enrichment data */
  let currentSmarty: SmartyPropertyData | null = null;
  /** OSM building footprint data */
  let currentOSM: OSMBuildingData | null = null;
  /** Whether a pool was detected from satellite imagery */
  let currentPoolDetected = false;
  /** Street View image URL (if available) */
  let currentStreetViewUrl: string | null = null;
  /** Parcl Labs property data — stored for generation-time access */
  let currentParcl: ParclPropertyData | null = null;
  /** Mapillary best image + features */
  let currentMapillaryImage: MapillaryImageData | null = null;
  let currentMapillaryFeatures: MapillaryFeatureData[] = [];
  /** Satellite footprint extraction result */
  let currentSatFootprint: FootprintResult | null = null;
  /** Street View color analysis (browser-side) */
  let currentSvColors: BrowserSvColorResult | null = null;
  /** Promise for in-flight SV analysis — awaited in doGenerate to avoid race condition */
  let svAnalysisPromise: Promise<BrowserSvColorResult | null> | null = null;
  /** Mapbox building height data */
  let currentMapboxBuilding: MapboxBuildingResult | null = null;
  /** Google Solar API building insights */
  let currentSolar: SolarBuildingData | null = null;
  /** Street View metadata (capture date, camera position) */
  let currentSvMeta: StreetViewMetadata | null = null;
  /** Elevation grid for terrain slope computation */
  let currentElevGrid: ElevationGrid | null = null;
  /** NLCD tree canopy cover percentage (0–99) */
  let currentNlcdCanopy: NlcdCanopyResult | null = null;
  /** USDA Plant Hardiness Zone result */
  let currentHardiness: HardinessResult | null = null;
  /** Individual trees from OSM near the property */
  let currentOSMTrees: OSMTreeData[] = [];
  /** Overture Maps building attributes (height, floors, roof, facade) */
  let currentOverture: OvertureBuildingData | null = null;
  /** Water features near the property */
  let currentWater: WaterFeature[] = [];
  /** Meta/WRI canopy height at the property */
  let currentCanopyHeight: CanopyHeightResult | null = null;
  /** ESA WorldCover land cover at the property */
  let currentLandCover: LandCoverResult | null = null;
  /** JSON-imported PropertyData fields that lack dedicated current* state variables.
   *  Merged into the constructed PropertyData at generation time for round-trip fidelity. */
  let importedPropertyOverrides: Partial<PropertyData> | null = null;
  /** Pre-lookup form defaults — restored when APIs that populated fields are toggled off */
  let preLookupDefaults = {
    stories: 2, sqft: 2000, bedrooms: 3, bathrooms: 2, yearBuilt: 2000, propertyType: 'house',
  };

  // Restore API key display state
  const savedParclKey = getParclApiKey();
  const parclKeyMasked = savedParclKey ? '••••' + savedParclKey.slice(-4) : '';
  const smartyCustomKey = hasCustomSmartyKey();
  const smartyKeyDisplay = smartyCustomKey ? '••••' + getSmartyKey().slice(-4) : 'Built-in';
  const savedStreetViewKey = getStreetViewApiKey();
  const svKeyMasked = savedStreetViewKey ? '••••' + savedStreetViewKey.slice(-4) : '';
  const savedMapboxToken = getMapboxToken();
  const mbTokenMasked = savedMapboxToken ? '••••' + savedMapboxToken.slice(-4) : '';
  const savedMlyToken = getMapillaryMlyToken();
  const mlyTokenMasked = savedMlyToken ? '••••' + savedMlyToken.slice(-4) : '';

  controls.innerHTML = `
    <div class="section-title">Import from Address</div>

    <!-- API keys (collapsible, defaults closed — expand via button) -->
    <details class="customize-section" id="import-api-section">
      <summary class="customize-summary">API Keys
        <span class="import-api-badge" id="import-api-badge">${
          [savedParclKey, true /* Smarty embedded */, savedStreetViewKey, savedMapboxToken, savedMlyToken].filter(Boolean).length
        }/5</span>
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
        <!-- Smarty property data (embedded key, user can override) -->
        <div class="import-api-row">
          <div class="import-api-label">
            <strong>Smarty</strong>
            <span class="import-api-desc">construction, roof, amenities, assessor</span>
          </div>
          <div class="import-api-input-row">
            <input id="import-smarty-key" type="password" class="form-input import-api-key-input"
              placeholder="Built-in key active" value="${smartyCustomKey ? escapeAttr(getSmartyKey()) : ''}">
            <button id="import-smarty-save" class="btn btn-secondary btn-sm">${smartyCustomKey ? 'Saved' : 'Save'}</button>
            <a href="https://www.smarty.com/account/create" target="_blank" rel="noopener"
              class="import-api-link" title="Get free key">Get key</a>
          </div>
          <div id="import-smarty-status" class="import-api-status">
            ${smartyKeyDisplay === 'Built-in' ? 'Built-in key active (IP-restricted)' : `Custom key: ${smartyKeyDisplay}`}
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
        <!-- Mapillary token -->
        <div class="import-api-row">
          <div class="import-api-label">
            <strong>Mapillary</strong>
            <span class="import-api-desc">free street photos + features</span>
          </div>
          <div class="import-api-input-row">
            <input id="import-mly-token" type="password" class="form-input import-api-key-input"
              placeholder="Paste client token" value="${escapeAttr(savedMlyToken)}">
            <button id="import-mly-save" class="btn btn-secondary btn-sm">${savedMlyToken ? 'Saved' : 'Save'}</button>
            <a href="${MAPILLARY_SIGNUP_URL}" target="_blank" rel="noopener"
              class="import-api-link" title="Get free token">Get token</a>
          </div>
          <div id="import-mly-status" class="import-api-status">
            ${mlyTokenMasked ? `Token stored: ${mlyTokenMasked}` : 'No token — no Mapillary street view'}
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

    <!-- API source toggles — disable individual sources to see their impact -->
    <details class="customize-section" id="import-api-toggles-section">
      <summary class="customize-summary">API Sources for Generation</summary>
      <div class="customize-body">
        <div class="import-api-toggles" id="import-api-toggles">
          <label class="import-api-toggle"><input type="checkbox" data-api="parcl" checked><span>Parcl</span></label>
          <label class="import-api-toggle"><input type="checkbox" data-api="smarty" checked><span>Smarty</span></label>
          <label class="import-api-toggle"><input type="checkbox" data-api="google" checked><span>Google SV + Solar</span></label>
          <label class="import-api-toggle"><input type="checkbox" data-api="mapbox" checked><span>Mapbox</span></label>
          <label class="import-api-toggle"><input type="checkbox" data-api="mapillary" checked><span>Mapillary</span></label>
          <label class="import-api-toggle"><input type="checkbox" data-api="osm" checked><span>OSM</span></label>
          <label class="import-api-toggle"><input type="checkbox" data-api="elevation" checked><span>Elevation</span></label>
          <div class="import-api-divider"></div>
          <label class="import-api-toggle"><input type="checkbox" data-api="nlcd" checked><span>NLCD Canopy</span></label>
          <label class="import-api-toggle"><input type="checkbox" data-api="hardiness" checked><span>Hardiness Zone</span></label>
          <label class="import-api-toggle"><input type="checkbox" data-api="osmtrees" checked><span>OSM Trees</span></label>
          <label class="import-api-toggle"><input type="checkbox" data-api="overture" checked><span>Overture Maps</span></label>
          <label class="import-api-toggle"><input type="checkbox" data-api="water" checked><span>Water Features</span></label>
          <label class="import-api-toggle"><input type="checkbox" data-api="canopyht" checked><span>Canopy Height</span></label>
          <label class="import-api-toggle"><input type="checkbox" data-api="landcover" checked><span>Land Cover</span></label>
        </div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px;">Uncheck to exclude from generation.</div>
      </div>
    </details>

    <!-- Enrichment data (populated after lookup) -->
    <details class="customize-section" id="import-enrichment-section" style="display:none;">
      <summary class="customize-summary">Enrichment Data
        <span class="import-api-badge" id="import-enrich-badge">0</span>
      </summary>
      <div class="customize-body" id="import-enrichment-body"></div>
    </details>

    <!-- Advanced property details (editable fields that impact generation) -->
    <details class="customize-section" id="import-advanced-section">
      <summary class="customize-summary">Advanced Details</summary>
      <div class="customize-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Roof Material</label>
            <select id="import-roof-type" class="form-select">
              <option value="">Unknown</option>
              <option value="Asphalt Shingle">Asphalt Shingle</option>
              <option value="Metal">Metal</option>
              <option value="Clay Tile">Clay Tile</option>
              <option value="Slate">Slate</option>
              <option value="Wood Shake">Wood Shake</option>
              <option value="Flat Membrane">Flat Membrane</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Exterior Walls</label>
            <select id="import-exterior-type" class="form-select">
              <option value="">Unknown</option>
              <option value="Wood">Wood</option>
              <option value="Brick">Brick</option>
              <option value="Stone">Stone</option>
              <option value="Stucco">Stucco</option>
              <option value="Vinyl">Vinyl</option>
              <option value="Concrete">Concrete</option>
              <option value="Metal">Metal</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Construction</label>
            <select id="import-construction" class="form-select">
              <option value="">Unknown</option>
              <option value="Frame">Frame</option>
              <option value="Masonry">Masonry</option>
              <option value="Concrete">Concrete</option>
              <option value="Steel">Steel</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Foundation</label>
            <select id="import-foundation" class="form-select">
              <option value="">Unknown</option>
              <option value="Slab">Slab</option>
              <option value="Crawl Space">Crawl Space</option>
              <option value="Basement">Basement</option>
              <option value="Pier">Pier</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Roof Frame</label>
            <select id="import-roof-frame" class="form-select">
              <option value="">Unknown</option>
              <option value="Gable">Gable</option>
              <option value="Hip">Hip</option>
              <option value="Flat">Flat</option>
              <option value="Gambrel">Gambrel</option>
              <option value="Mansard">Mansard</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Driveway</label>
            <select id="import-driveway" class="form-select">
              <option value="">Unknown</option>
              <option value="Asphalt">Asphalt</option>
              <option value="Concrete">Concrete</option>
              <option value="Gravel">Gravel</option>
              <option value="None">None</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Lot Size (sqft)</label>
            <input id="import-lot-size" type="number" class="form-input" placeholder="0" min="0" max="500000">
          </div>
          <div class="form-group">
            <label class="form-label">Garage Sq Ft</label>
            <input id="import-garage-sqft" type="number" class="form-input" placeholder="0" min="0" max="5000">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Fireplaces</label>
            <input id="import-fireplace-count" type="number" class="form-input" placeholder="0" min="0" max="10">
          </div>
          <div class="form-group">
            <label class="form-label">Total Rooms</label>
            <input id="import-total-rooms" type="number" class="form-input" placeholder="0" min="0" max="50">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Heating Fuel</label>
            <select id="import-heating-fuel" class="form-select">
              <option value="">Unknown</option>
              <option value="Natural Gas">Natural Gas</option>
              <option value="Electric">Electric</option>
              <option value="Oil">Oil</option>
              <option value="Propane">Propane</option>
              <option value="Wood">Wood</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">AC Type</label>
            <select id="import-ac-type" class="form-select">
              <option value="">Unknown</option>
              <option value="Central">Central</option>
              <option value="Window">Window</option>
              <option value="None">None</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Heating System</label>
            <select id="import-heating-system" class="form-select">
              <option value="">Unknown</option>
              <option value="Forced Air">Forced Air</option>
              <option value="Radiator">Radiator</option>
              <option value="Baseboard">Baseboard</option>
              <option value="Heat Pump">Heat Pump</option>
            </select>
          </div>
          <div class="form-group"></div>
        </div>
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
      <div style="display:flex;gap:6px;">
        <button id="import-json-btn" class="btn btn-secondary btn-sm" style="flex:1;">
          Import JSON
        </button>
        <button id="import-export-json-btn" class="btn btn-secondary btn-sm" style="flex:1;">
          Export JSON
        </button>
      </div>
      <input type="file" id="import-json-file" accept=".json,application/json" hidden>
      <div id="import-info" class="info-panel" hidden></div>
    </div>
  `;

  // ── DOM refs ──────────────────────────────────────────────────────────
  const addressInput = controls.querySelector('#import-address') as HTMLInputElement;
  const lookupBtn = controls.querySelector('#import-lookup') as HTMLButtonElement;
  const statusEl = controls.querySelector('#import-status') as HTMLElement;
  const generateBtn = controls.querySelector('#import-generate') as HTMLButtonElement;
  const jsonImportBtn = controls.querySelector('#import-json-btn') as HTMLButtonElement;
  const jsonExportBtn = controls.querySelector('#import-export-json-btn') as HTMLButtonElement;
  const jsonFileInput = controls.querySelector('#import-json-file') as HTMLInputElement;
  const infoPanel = controls.querySelector('#import-info') as HTMLElement;
  const floorPlanDrop = controls.querySelector('#import-floorplan-drop') as HTMLElement;
  const floorPlanInput = controls.querySelector('#import-floorplan-input') as HTMLInputElement;
  const floorPlanInfo = controls.querySelector('#import-floorplan-info') as HTMLElement;
  const parclKeyInput = controls.querySelector('#import-parcl-key') as HTMLInputElement;
  const parclSaveBtn = controls.querySelector('#import-parcl-save') as HTMLButtonElement;
  const parclStatus = controls.querySelector('#import-parcl-status') as HTMLElement;
  const smartyKeyInput = controls.querySelector('#import-smarty-key') as HTMLInputElement;
  const smartySaveBtn = controls.querySelector('#import-smarty-save') as HTMLButtonElement;
  const smartyStatus = controls.querySelector('#import-smarty-status') as HTMLElement;
  const svKeyInput = controls.querySelector('#import-sv-key') as HTMLInputElement;
  const svSaveBtn = controls.querySelector('#import-sv-save') as HTMLButtonElement;
  const svStatus = controls.querySelector('#import-sv-status') as HTMLElement;
  const mbTokenInput = controls.querySelector('#import-mb-token') as HTMLInputElement;
  const mbSaveBtn = controls.querySelector('#import-mb-save') as HTMLButtonElement;
  const mbStatus = controls.querySelector('#import-mb-status') as HTMLElement;
  const mlyTokenInput = controls.querySelector('#import-mly-token') as HTMLInputElement;
  const mlySaveBtn = controls.querySelector('#import-mly-save') as HTMLButtonElement;
  const mlyStatus = controls.querySelector('#import-mly-status') as HTMLElement;
  const apiSection = controls.querySelector('#import-api-section') as HTMLDetailsElement;
  const enrichSection = controls.querySelector('#import-enrichment-section') as HTMLDetailsElement;
  const enrichBody = controls.querySelector('#import-enrichment-body') as HTMLElement;
  const enrichBadge = controls.querySelector('#import-enrich-badge') as HTMLElement;
  // Advanced property detail inputs
  const roofTypeSelect = controls.querySelector('#import-roof-type') as HTMLSelectElement;
  const exteriorTypeSelect = controls.querySelector('#import-exterior-type') as HTMLSelectElement;
  const constructionSelect = controls.querySelector('#import-construction') as HTMLSelectElement;
  const foundationSelect = controls.querySelector('#import-foundation') as HTMLSelectElement;
  const roofFrameSelect = controls.querySelector('#import-roof-frame') as HTMLSelectElement;
  const drivewaySelect = controls.querySelector('#import-driveway') as HTMLSelectElement;
  const lotSizeInput = controls.querySelector('#import-lot-size') as HTMLInputElement;
  const garageSqftInput = controls.querySelector('#import-garage-sqft') as HTMLInputElement;
  const fireplaceCountInput = controls.querySelector('#import-fireplace-count') as HTMLInputElement;
  const totalRoomsInput = controls.querySelector('#import-total-rooms') as HTMLInputElement;
  const heatingFuelSelect = controls.querySelector('#import-heating-fuel') as HTMLSelectElement;
  const acTypeSelect = controls.querySelector('#import-ac-type') as HTMLSelectElement;
  const heatingSystemSelect = controls.querySelector('#import-heating-system') as HTMLSelectElement;

  // Form field refs for persistence
  const fieldIds = ['import-stories', 'import-sqft', 'import-beds', 'import-baths', 'import-year'] as const;
  const fieldKeys = ['stories', 'sqft', 'beds', 'baths', 'year'] as const;

  // ── API Key management ────────────────────────────────────────────────
  const apiBadge = controls.querySelector('#import-api-badge') as HTMLElement;

  /** Update the N/5 badge count after any key save */
  function updateApiBadge(): void {
    const count = [hasParclApiKey(), hasSmartyKey(), hasStreetViewApiKey(), hasMapboxToken(), hasMapillaryMlyToken()]
      .filter(Boolean).length;
    apiBadge.textContent = `${count}/5`;
  }

  // Data-driven API key save handlers — DRY replacement for 5 identical patterns
  const apiKeyConfigs = [
    { input: parclKeyInput, btn: parclSaveBtn, status: parclStatus,
      set: setParclApiKey, noKeyMsg: 'No key — manual entry only' },
    { input: smartyKeyInput, btn: smartySaveBtn, status: smartyStatus,
      set: setSmartyKey, noKeyMsg: 'Built-in key active (IP-restricted)' },
    { input: svKeyInput, btn: svSaveBtn, status: svStatus,
      set: setStreetViewApiKey, noKeyMsg: 'No key — no exterior photo' },
    { input: mbTokenInput, btn: mbSaveBtn, status: mbStatus,
      set: setMapboxToken, noKeyMsg: 'No token — using ESRI satellite' },
    { input: mlyTokenInput, btn: mlySaveBtn, status: mlyStatus,
      set: setMapillaryMlyToken, noKeyMsg: 'No token — no Mapillary street view' },
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

    // Run geocoding, Parcl API, and Smarty lookup in parallel
    showStatus('Looking up property...', 'loading');

    // Clear JSON import overrides — fresh API data takes priority
    importedPropertyOverrides = null;

    // Snapshot form defaults before API data overwrites them — used at generation
    // time to restore original values when an API's toggle is disabled
    preLookupDefaults = {
      stories: parseInt((controls.querySelector('#import-stories') as HTMLInputElement).value) || 2,
      sqft: parseInt((controls.querySelector('#import-sqft') as HTMLInputElement).value) || 2000,
      bedrooms: parseInt((controls.querySelector('#import-beds') as HTMLInputElement).value) || 3,
      bathrooms: parseInt((controls.querySelector('#import-baths') as HTMLInputElement).value) || 2,
      yearBuilt: parseInt((controls.querySelector('#import-year') as HTMLInputElement).value) || 2000,
      propertyType: propTypeEl.value,
    };

    // Reset enrichment state for new lookup
    currentWallOverride = undefined;
    currentDetectedColor = undefined;
    currentSmarty = null;
    currentOSM = null;
    currentPoolDetected = false;
    currentStreetViewUrl = null;
    currentParcl = null;
    currentMapillaryImage = null;
    currentMapillaryFeatures = [];
    currentSatFootprint = null;
    currentSvColors = null;
    svAnalysisPromise = null;
    currentMapboxBuilding = null;
    currentSolar = null;
    currentSvMeta = null;
    currentElevGrid = null;
    currentNlcdCanopy = null;
    currentHardiness = null;
    currentOSMTrees = [];
    currentOverture = null;
    currentWater = [];
    currentCanopyHeight = null;
    currentLandCover = null;

    const [geoResult, parclResult, smartyResult] = await Promise.allSettled([
      geocodeAddress(address),
      hasParclApiKey() ? searchParclProperty(address) : Promise.resolve(null),
      searchSmartyProperty(address),
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

      // Fire OSM + Street View + Mapillary + Mapbox + Solar in parallel
      const mlyToken = getMapillaryMlyToken();
      const svApiKey = getStreetViewApiKey();
      const [osmResult, svResult, mlyImgResult, mlyFeatResult, mbBuildingResult, solarResult] = await Promise.allSettled([
        searchOSMBuilding(geo.lat, geo.lng),
        hasStreetViewApiKey()
          ? fetchStreetViewMetadata(geo.lat, geo.lng, svApiKey)
          : Promise.resolve({ available: false } as StreetViewMetadata),
        mlyToken ? searchMapillaryImages(geo.lat, geo.lng, mlyToken) : Promise.resolve(null),
        mlyToken ? searchMapillaryFeatures(geo.lat, geo.lng, mlyToken) : Promise.resolve(null),
        hasMapboxToken() ? queryMapboxBuildingHeight(geo.lat, geo.lng) : Promise.resolve(null),
        // Solar API uses same Google API key as Street View
        hasStreetViewApiKey() ? querySolarBuildingInsights(geo.lat, geo.lng, svApiKey) : Promise.resolve(null),
      ]);

      // Process OSM result
      if (osmResult.status === 'fulfilled' && osmResult.value) {
        currentOSM = osmResult.value;
      }

      // Process Street View result — extract metadata + kick off color analysis
      if (svResult.status === 'fulfilled' && svResult.value?.available) {
        currentSvMeta = svResult.value;
        currentStreetViewUrl = getStreetViewUrl(geo.lat, geo.lng, svApiKey);
        // Analyze SV image for wall/roof/trim colors — store promise for doGenerate() to await
        svAnalysisPromise = analyzeStreetViewBrowser(currentStreetViewUrl).then(result => {
          if (result) currentSvColors = result;
          return result;
        }).catch(() => null);
      }

      // Process Solar API result
      if (solarResult.status === 'fulfilled' && solarResult.value) {
        currentSolar = solarResult.value;
      }

      // Process Mapbox building height result
      if (mbBuildingResult.status === 'fulfilled' && mbBuildingResult.value) {
        currentMapboxBuilding = mbBuildingResult.value;
      }

      // Fetch elevation grid in background (non-blocking, used for terrain slope)
      // ~200m bbox around the building center, same as CLI
      const PAD = 0.002;
      fetchElevationGrid(geo.lat - PAD, geo.lng - PAD, geo.lat + PAD, geo.lng + PAD)
        .then(grid => { if (grid) currentElevGrid = grid; })
        .catch(() => { /* non-fatal */ });

      // Phase 5 P0: NLCD tree canopy, hardiness zone, OSM trees (non-blocking)
      queryNlcdCanopy(geo.lat, geo.lng)
        .then(r => { currentNlcdCanopy = r; })
        .catch(() => { /* non-fatal */ });
      // Hardiness zone needs ZIP code — Parcl result already settled at this point
      const parclZip = parclResult.status === 'fulfilled' ? parclResult.value?.zipCode : undefined;
      if (parclZip) {
        queryHardinessZone(parclZip)
          .then(r => { currentHardiness = r; })
          .catch(() => { /* non-fatal */ });
      }
      searchOSMTrees(geo.lat, geo.lng, 150)
        .then(trees => { currentOSMTrees = trees; })
        .catch(() => { /* non-fatal */ });
      // Overture Maps building attributes (height, floors, roof, facade)
      queryOvertureBuilding(geo.lat, geo.lng)
        .then(r => { currentOverture = r; })
        .catch(() => { /* non-fatal */ });
      // Phase 5 P1: water features, canopy height, land cover (non-blocking)
      searchWaterFeatures(geo.lat, geo.lng, 500)
        .then(w => { currentWater = w; })
        .catch(() => { /* non-fatal */ });
      queryCanopyHeight(geo.lat, geo.lng)
        .then(r => { currentCanopyHeight = r; })
        .catch(() => { /* non-fatal */ });
      queryLandCover(geo.lat, geo.lng)
        .then(r => { currentLandCover = r; })
        .catch(() => { /* non-fatal */ });

      // Process Mapillary results
      if (mlyImgResult.status === 'fulfilled' && mlyImgResult.value) {
        const best = pickBestImage(mlyImgResult.value, geo.lat, geo.lng);
        if (best) currentMapillaryImage = best;
        // Use Mapillary as street view fallback if Google SV unavailable
        if (!currentStreetViewUrl && best?.thumbUrl) {
          currentStreetViewUrl = best.thumbUrl;
        }
      }
      if (mlyFeatResult.status === 'fulfilled' && mlyFeatResult.value) {
        currentMapillaryFeatures = mlyFeatResult.value;
      }

      // Build Mapbox tile fetcher if token is configured
      const tileFetcher = hasMapboxToken()
        ? createMapboxTileFetcher(getMapboxToken())
        : undefined;

      // Show satellite view (async, don't block) — also extract building color
      showSatelliteLoading(viewer);
      composeSatelliteView(geo.lat, geo.lng, 18, tileFetcher).then(canvas => {
        currentSeason = (canvas.dataset['season'] as SeasonalWeather) ?? undefined;

        // Show satellite canvas immediately so user sees imagery while analysis runs
        const { pixelX, pixelY } = getCrosshairPosition(geo.lat, geo.lng);
        showSatelliteCanvas(viewer, canvas, geo, currentSeason, undefined);

        // Defer heavy image analysis to next frame to avoid UI freeze on mobile
        requestAnimationFrame(() => {
          // Extract building color from satellite canvas around crosshair
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

          // Footprint extraction — detect building shape + dimensions from satellite pixels
          currentSatFootprint = extractFootprint(canvas, pixelX, pixelY, geo.lat);
          if (currentSatFootprint && currentSatFootprint.confidence >= 0.6) {
            drawFootprintOverlay(canvas, currentSatFootprint, pixelX, pixelY);
          }

          // Draw OSM building polygon overlay on satellite canvas
          if (currentOSM && currentOSM.polygon.length >= 3) {
            drawBuildingOutline(canvas, geo, currentOSM.polygon);
          }

          // Re-show canvas with overlays and detected color applied
          showSatelliteCanvas(viewer, canvas, geo, currentSeason, currentDetectedColor);
        });

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

    // Handle Smarty API result — enriches with construction details, amenities
    // Process Smarty first so wallOverride from exterior type takes priority (priority 1)
    if (smartyResult.status === 'fulfilled' && smartyResult.value) {
      currentSmarty = smartyResult.value;
      populateFromSmarty(smartyResult.value);
    }

    // Handle OSM enrichment — wallOverride priority 2 (below Smarty, above satellite color)
    if (currentOSM) {
      populateFromOSM(currentOSM);
    }

    // Mapbox height → story estimation (actual measurement, higher priority than heuristics)
    // Only apply if no authoritative story count from Smarty or OSM levels
    if (currentMapboxBuilding && currentMapboxBuilding.height > 0
        && !currentSmarty?.storiesNumber && !currentOSM?.levels) {
      const storiesEl = controls.querySelector('#import-stories') as HTMLInputElement;
      const h = currentMapboxBuilding.height;
      // Skyscraper detection: 50m+ and 2x taller than longest footprint side
      const longestSide = Math.max(currentOSM?.widthMeters ?? 0, currentOSM?.lengthMeters ?? 0);
      if (h >= 50 && longestSide > 0 && h >= 2 * longestSide) {
        // Raw height / typical floor height (3.5m for commercial)
        const est = Math.max(1, Math.round(h / 3.5));
        storiesEl.value = String(est);
        saveField('stories', String(est));
      } else {
        // Standard buildings: ~3m per floor, clamp 1-10
        const est = Math.max(1, Math.min(10, Math.round(h / 3)));
        storiesEl.value = String(est);
        saveField('stories', String(est));
      }
      storiesEl.classList.add('import-field-filled');
      setTimeout(() => storiesEl.classList.remove('import-field-filled'), 1500);
    }

    // Solar footprint → story estimation (when Mapbox height unavailable)
    if (currentSolar?.buildingFootprintAreaSqm && currentSolar.buildingFootprintAreaSqm > 0
        && !currentMapboxBuilding?.height
        && !currentSmarty?.storiesNumber && !currentOSM?.levels) {
      const sqft = parseInt((controls.querySelector('#import-sqft') as HTMLInputElement).value) || 0;
      if (sqft > 0) {
        const totalSqm = sqft / 10.76;
        const est = Math.max(1, Math.min(5, Math.round(totalSqm / currentSolar.buildingFootprintAreaSqm)));
        const storiesEl = controls.querySelector('#import-stories') as HTMLInputElement;
        storiesEl.value = String(est);
        saveField('stories', String(est));
        storiesEl.classList.add('import-field-filled');
        setTimeout(() => storiesEl.classList.remove('import-field-filled'), 1500);
      }
    }

    // Handle Parcl API result — auto-fill form fields
    const geoSource = parclGeoFallback ? 'parcl' : currentGeocoding!.source;
    const statusParts: string[] = [currentGeocoding!.matchedAddress, `(${geoSource})`];
    if (parclResult.status === 'fulfilled' && parclResult.value) {
      currentParcl = parclResult.value;
      populateFromParcl(parclResult.value);
      statusParts.push('— property data loaded');
    }
    if (currentSmarty) {
      statusParts.push(currentSmarty.exteriorWalls ? `| ${currentSmarty.exteriorWalls}` : '');
    }
    if (currentOSM) {
      statusParts.push(`| ${currentOSM.widthMeters}m × ${currentOSM.lengthMeters}m (OSM)`);
    }
    if (currentMapboxBuilding) {
      statusParts.push(`| ${currentMapboxBuilding.height.toFixed(1)}m (Mapbox)`);
    }
    if (currentSolar) {
      statusParts.push(`| Solar: ${currentSolar.roofSegmentCount} segs`);
    }
    if (currentSvMeta?.available) {
      statusParts.push(`| SV: ${currentSvMeta.date ?? 'available'}`);
    }
    showStatus(statusParts.filter(Boolean).join(' '), 'success');

    // Populate advanced fields from Smarty data
    populateAdvancedFields();

    // Enrichment panel is populated after a short delay to allow async P1 sources
    // (NLCD, hardiness, trees, overture, water, canopy, land cover) to settle
    setTimeout(updateEnrichmentPanel, 2500);

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

  /** Populate form fields and wallOverride from Smarty property data */
  function populateFromSmarty(sm: SmartyPropertyData): void {
    // Stories from assessor records (most reliable source)
    if (sm.storiesNumber && sm.storiesNumber > 0) {
      const storiesEl = controls.querySelector('#import-stories') as HTMLInputElement;
      storiesEl.value = String(sm.storiesNumber);
      saveField('stories', String(sm.storiesNumber));
      storiesEl.classList.add('import-field-filled');
      setTimeout(() => storiesEl.classList.remove('import-field-filled'), 1500);
    }

    // Exterior walls → wall material override (highest priority for wallOverride)
    if (sm.exteriorWalls) {
      const mapped = mapSmartyExteriorToWall(sm.exteriorWalls);
      if (mapped) {
        currentWallOverride = mapped;
      }
    }

    // Pool detection from assessor records (overrides satellite inference)
    if (sm.hasPool) currentPoolDetected = true;

    // Backfill beds/baths/sqft/year if Parcl didn't provide them
    const backfillMap: [string, string, number][] = [
      ['import-sqft', 'sqft', sm.buildingSqft],
      ['import-beds', 'beds', sm.bedrooms],
      ['import-baths', 'baths', sm.bathroomsTotal],
      ['import-year', 'year', sm.yearBuilt],
    ];
    for (const [id, key, value] of backfillMap) {
      if (value && value > 0) {
        const el = controls.querySelector(`#${id}`) as HTMLInputElement;
        const current = parseInt(el.value) || 0;
        if (current === 0 || el.value === loadField(key)) continue;
      }
    }
  }

  /** Populate form fields and wallOverride from OSM building data */
  function populateFromOSM(osm: OSMBuildingData): void {
    const storiesEl = controls.querySelector('#import-stories') as HTMLInputElement;

    // Stories priority: Smarty storiesNumber (already set) > OSM levels > footprint calc
    if (!currentSmarty?.storiesNumber) {
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

    // Wall material from OSM — priority 2 (below Smarty exteriorWalls, above satellite color)
    if (osm.material && !currentWallOverride) {
      const mapped = mapOSMMaterialToWall(osm.material);
      if (mapped) {
        currentWallOverride = mapped;
      }
    }
  }

  /** Populate the enrichment data panel with all API-retrieved data (read-only summary) */
  function updateEnrichmentPanel(): void {
    const sections: string[] = [];
    let sourceCount = 0;

    // Vegetation & landscape
    const vegParts: string[] = [];
    if (currentNlcdCanopy) { vegParts.push(`NLCD canopy: ${currentNlcdCanopy.canopyCoverPct}%`); sourceCount++; }
    if (currentHardiness) { vegParts.push(`Hardiness zone: ${currentHardiness.zone}`); sourceCount++; }
    if (currentOSMTrees.length > 0) { vegParts.push(`Nearby trees: ${currentOSMTrees.length}`); sourceCount++; }
    if (currentCanopyHeight) { vegParts.push(`Canopy height: ${currentCanopyHeight.heightMeters.toFixed(1)}m`); sourceCount++; }
    if (currentLandCover) { vegParts.push(`Land cover: ${currentLandCover.label ?? `class ${currentLandCover.classValue}`}`); sourceCount++; }
    if (vegParts.length) sections.push(`<div class="enrich-group"><span class="enrich-label">Vegetation</span><span class="enrich-val">${vegParts.join(' · ')}</span></div>`);

    // Building
    const bldParts: string[] = [];
    if (currentOverture) {
      const parts: string[] = [];
      if (currentOverture.height != null) parts.push(`${currentOverture.height.toFixed(1)}m`);
      if (currentOverture.numFloors != null) parts.push(`${currentOverture.numFloors}fl`);
      if (currentOverture.roofShape) parts.push(currentOverture.roofShape);
      if (parts.length) { bldParts.push(`Overture: ${parts.join(', ')}`); sourceCount++; }
    }
    if (currentMapboxBuilding) { bldParts.push(`Mapbox: ${currentMapboxBuilding.height.toFixed(1)}m`); sourceCount++; }
    if (currentSolar) {
      bldParts.push(`Solar: ${currentSolar.roofSegmentCount} segs, ${currentSolar.primaryPitchDegrees?.toFixed(0) ?? '?'}° pitch`);
      sourceCount++;
    }
    if (currentOSM) {
      bldParts.push(`OSM: ${currentOSM.widthMeters?.toFixed(0) ?? '?'}×${currentOSM.lengthMeters?.toFixed(0) ?? '?'}m`);
      sourceCount++;
    }
    if (bldParts.length) sections.push(`<div class="enrich-group"><span class="enrich-label">Building</span><span class="enrich-val">${bldParts.join(' · ')}</span></div>`);

    // Water
    if (currentWater.length > 0) {
      const names = currentWater.slice(0, 3).map(w => w.name || w.type).join(', ');
      sections.push(`<div class="enrich-group"><span class="enrich-label">Water</span><span class="enrich-val">${currentWater.length} features (${names})</span></div>`);
      sourceCount++;
    }

    // HVAC (from Smarty)
    if (currentSmarty) {
      const hvacParts: string[] = [];
      if (currentSmarty.heat) hvacParts.push(`Heat: ${currentSmarty.heat}`);
      if (currentSmarty.heatFuelType) hvacParts.push(`Fuel: ${currentSmarty.heatFuelType}`);
      if (currentSmarty.airConditioner) hvacParts.push(`AC: ${currentSmarty.airConditioner}`);
      if (hvacParts.length) sections.push(`<div class="enrich-group"><span class="enrich-label">HVAC</span><span class="enrich-val">${hvacParts.join(' · ')}</span></div>`);
    }

    // Property extras (from Smarty)
    if (currentSmarty) {
      const extraParts: string[] = [];
      if (currentSmarty.garageSqft) extraParts.push(`Garage: ${currentSmarty.garageSqft} sqft`);
      if (currentSmarty.fireplaceCount) extraParts.push(`Fireplaces: ${currentSmarty.fireplaceCount}`);
      if (currentSmarty.rooms) extraParts.push(`Rooms: ${currentSmarty.rooms}`);
      if (currentSmarty.totalMarketValue) extraParts.push(`Value: $${currentSmarty.totalMarketValue.toLocaleString()}`);
      if (extraParts.length) sections.push(`<div class="enrich-group"><span class="enrich-label">Property</span><span class="enrich-val">${extraParts.join(' · ')}</span></div>`);
    }

    // SV colors
    if (currentSvColors) {
      sections.push(`<div class="enrich-group"><span class="enrich-label">SV Colors</span><span class="enrich-val">Wall: <span class="import-color-swatch" style="background:rgb(${currentSvColors.wallColor.r},${currentSvColors.wallColor.g},${currentSvColors.wallColor.b})"></span> Roof: <span class="import-color-swatch" style="background:rgb(${currentSvColors.roofColor.r},${currentSvColors.roofColor.g},${currentSvColors.roofColor.b})"></span> Trim: <span class="import-color-swatch" style="background:rgb(${currentSvColors.trimColor.r},${currentSvColors.trimColor.g},${currentSvColors.trimColor.b})"></span></span></div>`);
      sourceCount++;
    }

    // Terrain
    if (currentElevGrid && currentGeocoding) {
      const slope = footprintSlope(
        currentElevGrid, currentGeocoding.lat, currentGeocoding.lng,
        currentOSM?.widthMeters ?? 15, currentOSM?.lengthMeters ?? 15,
      );
      if (slope > 0.5) {
        sections.push(`<div class="enrich-group"><span class="enrich-label">Terrain</span><span class="enrich-val">Slope: ${slope.toFixed(1)}m across footprint</span></div>`);
        sourceCount++;
      }
    }

    if (sections.length > 0) {
      enrichSection.style.display = '';
      enrichBody.innerHTML = sections.join('');
      enrichBadge.textContent = String(sourceCount);
    } else {
      enrichSection.style.display = 'none';
    }
  }

  /** Populate advanced property detail fields from Smarty data */
  function populateAdvancedFields(): void {
    if (!currentSmarty) return;
    if (currentSmarty.garageSqft) garageSqftInput.value = String(currentSmarty.garageSqft);
    if (currentSmarty.fireplaceCount) fireplaceCountInput.value = String(currentSmarty.fireplaceCount);
    if (currentSmarty.rooms) totalRoomsInput.value = String(currentSmarty.rooms);
    if (currentSmarty.heatFuelType) heatingFuelSelect.value = currentSmarty.heatFuelType;
    if (currentSmarty.airConditioner) acTypeSelect.value = currentSmarty.airConditioner;
    if (currentSmarty.heat) heatingSystemSelect.value = currentSmarty.heat;
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

  // ── JSON Import ──────────────────────────────────────────────────────
  jsonImportBtn.addEventListener('click', () => {
    // Show a dialog: paste JSON or pick file
    const text = prompt('Paste JSON here, or cancel and use the file picker:');
    if (text && text.trim()) {
      try {
        const json = JSON.parse(text);
        populateFromJSON(json);
      } catch {
        showStatus('Invalid JSON', 'error');
      }
    } else if (text === null) {
      // User cancelled prompt — offer file picker
      jsonFileInput.click();
    }
  });
  jsonFileInput.addEventListener('change', () => {
    const file = jsonFileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result as string);
        populateFromJSON(json);
      } catch {
        showStatus('Invalid JSON file', 'error');
      }
    };
    reader.readAsText(file);
    jsonFileInput.value = '';
  });

  // Export JSON — exports current enrichment state as PropertyData without requiring generation
  jsonExportBtn.addEventListener('click', () => {
    const property = buildCurrentPropertyData();
    const blob = new Blob(
      [JSON.stringify({ property }, null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const slug = (property.address || 'export').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
    a.download = `${slug}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  /** Populate form fields and enrichment state from imported JSON.
   *  Accepts either { property, genOptions } or a raw PropertyData object. */
  function populateFromJSON(json: Record<string, unknown>): void {
    // Unwrap { property: {...}, genOptions: {...} } or use raw
    const prop = (json.property ?? json) as Record<string, unknown>;

    // Fill address
    if (prop.address && typeof prop.address === 'string') {
      addressInput.value = prop.address;
      saveField('address', prop.address);
    }

    // Fill numeric form fields
    const fieldMap: [string, string, string][] = [
      ['import-stories', 'stories', 'stories'],
      ['import-sqft', 'sqft', 'sqft'],
      ['import-beds', 'beds', 'bedrooms'],
      ['import-baths', 'baths', 'bathrooms'],
      ['import-year', 'year', 'yearBuilt'],
    ];
    for (const [id, saveKey, propKey] of fieldMap) {
      const val = prop[propKey];
      if (val != null && val !== 0) {
        const el = controls.querySelector(`#${id}`) as HTMLInputElement;
        el.value = String(val);
        saveField(saveKey, String(val));
      }
    }

    // Property type
    if (prop.propertyType && typeof prop.propertyType === 'string') {
      propTypeEl.value = prop.propertyType;
      saveField('proptype', prop.propertyType);
    }

    // Style
    if (prop.style && typeof prop.style === 'string') {
      selectedStyle = prop.style as StyleName | 'auto';
      const chips = controls.querySelectorAll('.style-chip');
      chips.forEach(c => {
        c.classList.toggle('active', (c as HTMLElement).dataset['style'] === selectedStyle);
      });
      saveField('style', prop.style);
    }

    // Geocoding
    const geo = prop.geocoding as { lat?: number; lng?: number; matchedAddress?: string; source?: string } | undefined;
    if (geo?.lat && geo?.lng) {
      currentGeocoding = {
        lat: geo.lat,
        lng: geo.lng,
        matchedAddress: geo.matchedAddress ?? '',
        source: (geo.source ?? 'json') as 'census' | 'nominatim',
      };
    }

    // Enrichment state from JSON — OSM data
    if (prop.osmWidth != null) {
      const w = (prop.osmWidth as number) ?? 0;
      const l = (prop.osmLength as number) ?? 0;
      currentOSM = {
        polygon: (prop.osmPolygon as { lat: number; lon: number }[]) ?? [],
        innerPolygons: (prop.osmInnerPolygons as { lat: number; lon: number }[][]) ?? undefined,
        widthMeters: w,
        lengthMeters: l,
        widthBlocks: w,
        lengthBlocks: l,
        footprintAreaSqm: w * l,
        levels: (prop.osmLevels as number) ?? undefined,
        material: (prop.osmMaterial as string) ?? undefined,
        roofShape: (prop.osmRoofShape as string) ?? undefined,
        roofMaterial: (prop.osmRoofMaterial as string) ?? undefined,
        buildingColour: (prop.osmBuildingColour as string) ?? undefined,
        roofColour: (prop.osmRoofColour as string) ?? undefined,
        tags: {},
      };
    }

    // Smarty enrichment — reconstruct from property fields
    if (prop.exteriorType || prop.constructionType || prop.architectureType) {
      currentSmarty = {
        structureStyle: (prop.architectureType as string) ?? '',
        exteriorWalls: (prop.exteriorType as string) ?? '',
        roofCover: (prop.roofType as string) ?? '',
        constructionType: (prop.constructionType as string) ?? '',
        foundation: (prop.foundation as string) ?? '',
        roofFrame: (prop.roofFrame as string) ?? '',
        hasGarage: (prop.hasGarage as boolean) ?? false,
        hasFireplace: (prop.hasFireplace as boolean) ?? false,
        hasDeck: (prop.hasDeck as boolean) ?? false,
        hasPorch: (prop.smartyHasPorch as boolean) ?? false,
        hasPool: (prop.smartyHasPool as boolean) ?? false,
        hasFence: (prop.smartyHasFence as boolean) ?? false,
        drivewayType: (prop.drivewayType as string) ?? '',
        assessedValue: (prop.assessedValue as number) ?? 0,
        lotSqft: (prop.lotSize as number) ?? 0,
        storiesNumber: (prop.stories as number) ?? 0,
        buildingSqft: (prop.sqft as number) ?? 0,
        acres: 0,
        bedrooms: (prop.bedrooms as number) ?? 0,
        bathroomsTotal: (prop.bathrooms as number) ?? 0,
        rooms: (prop.totalRooms as number) ?? 0,
        yearBuilt: (prop.yearBuilt as number) ?? 0,
        garageSqft: (prop.garageSqft as number) ?? 0,
        fireplaceCount: (prop.fireplaceCount as number) ?? 0,
        airConditioner: (prop.airConditioningType as string) ?? '',
        heat: (prop.heatingSystemType as string) ?? '',
        heatFuelType: (prop.heatingFuelType as string) ?? '',
        totalMarketValue: (prop.totalMarketValue as number) ?? 0,
        latitude: geo?.lat ?? 0,
        longitude: geo?.lng ?? 0,
      };
    }

    // Parcl data
    if (prop.city || prop.stateAbbreviation || prop.zipCode) {
      currentParcl = {
        address: (prop.address as string) ?? '',
        city: (prop.city as string) ?? '',
        stateAbbreviation: (prop.stateAbbreviation as string) ?? '',
        zipCode: (prop.zipCode as string) ?? '',
        county: (prop.county as string) ?? '',
        squareFootage: (prop.sqft as number) ?? 0,
        bedrooms: (prop.bedrooms as number) ?? 0,
        bathrooms: (prop.bathrooms as number) ?? 0,
        yearBuilt: (prop.yearBuilt as number) ?? 0,
        propertyType: (prop.propertyType as string) ?? '',
        newConstruction: (prop.newConstruction as boolean) ?? false,
        ownerOccupied: (prop.ownerOccupied as boolean) ?? false,
        onMarket: (prop.onMarket as boolean) ?? false,
        latitude: geo?.lat ?? 0,
        longitude: geo?.lng ?? 0,
        parclPropertyId: Number(prop.parclPropertyId) || 0,
      };
    }

    // Wall override
    if (prop.wallOverride) currentWallOverride = prop.wallOverride as BlockState;

    // Detected color
    if (prop.detectedColor) {
      currentDetectedColor = prop.detectedColor as { r: number; g: number; b: number };
    }

    // SV colors
    if (prop.svWallOverride) {
      currentSvColors = {
        wallBlock: prop.svWallOverride as BlockState,
        roofOverride: (prop.svRoofOverride as BrowserSvColorResult['roofOverride']) ??
          { north: 'minecraft:stone_brick_stairs[facing=north]', south: 'minecraft:stone_brick_stairs[facing=south]', cap: 'minecraft:stone_brick_slab[type=bottom]' },
        trimBlock: (prop.svTrimOverride as BlockState) ?? 'minecraft:white_concrete',
        wallColor: { r: 200, g: 200, b: 200 },
        roofColor: { r: 100, g: 100, b: 100 },
        trimColor: { r: 220, g: 220, b: 220 },
      };
    }

    // Mapbox height
    if (prop.mapboxHeight) {
      currentMapboxBuilding = {
        height: prop.mapboxHeight as number,
        minHeight: 0,
        buildingType: (prop.mapboxBuildingType as string) ?? undefined,
        extrude: true,
        distance: 0,
      };
    }

    // Solar API data
    if (prop.solarRoofPitch || prop.solarRoofSegments || prop.solarBuildingArea) {
      currentSolar = {
        primaryPitchDegrees: (prop.solarRoofPitch as number) ?? 0,
        primaryAzimuthDegrees: (prop.solarAzimuthDegrees as number) ?? 0,
        roofSegmentCount: (prop.solarRoofSegments as number) ?? 0,
        totalRoofAreaSqm: (prop.solarRoofArea as number) ?? 0,
        buildingFootprintAreaSqm: (prop.solarBuildingArea as number) ?? 0,
        primaryPlaneHeight: 0,
        imageryQuality: 'IMPORTED',
      };
    }

    // Street view URL + metadata
    if (prop.streetViewUrl) currentStreetViewUrl = prop.streetViewUrl as string;
    if (prop.streetViewDate || prop.streetViewHeading != null) {
      currentSvMeta = {
        available: true,
        date: (prop.streetViewDate as string) || undefined,
      };
    }

    // Season
    if (prop.season) currentSeason = prop.season as SeasonalWeather;

    // Uncertainty flags
    if (prop.yearUncertain) yearUncertain = true;
    if (prop.bedroomsUncertain) bedroomsUncertain = true;

    // Phase 5 P0: vegetation/landscape data
    if (prop.canopyCoverPct != null) {
      currentNlcdCanopy = { canopyCoverPct: prop.canopyCoverPct as number };
    }
    if (prop.hardinessZone) {
      currentHardiness = { zone: prop.hardinessZone as string };
    }
    if (Array.isArray(prop.nearbyTrees) && prop.nearbyTrees.length > 0) {
      currentOSMTrees = prop.nearbyTrees as OSMTreeData[];
    }
    // Overture Maps building data
    if (prop.overtureHeight != null || prop.overtureFloors != null || prop.overtureRoofShape) {
      currentOverture = {
        id: '',
        height: prop.overtureHeight as number | undefined,
        numFloors: prop.overtureFloors as number | undefined,
        roofShape: prop.overtureRoofShape as string | undefined,
        distanceMeters: 0,
      };
    }
    // P1: water, canopy, land cover
    if (Array.isArray(prop.nearbyWater) && prop.nearbyWater.length > 0) {
      currentWater = (prop.nearbyWater as WaterFeature[]);
    }
    if (prop.canopyHeightMeters != null) {
      currentCanopyHeight = { heightMeters: prop.canopyHeightMeters as number };
    }
    if (prop.landCoverClass != null) {
      currentLandCover = {
        classValue: prop.landCoverClass as number,
        label: prop.landCoverLabel as string ?? null,
      };
    }

    // Populate advanced property detail fields from JSON
    if (prop.garageSqft) garageSqftInput.value = String(prop.garageSqft);
    if (prop.fireplaceCount) fireplaceCountInput.value = String(prop.fireplaceCount);
    if (prop.totalRooms) totalRoomsInput.value = String(prop.totalRooms);
    if (prop.heatingFuelType) heatingFuelSelect.value = String(prop.heatingFuelType);
    if (prop.airConditioningType) acTypeSelect.value = String(prop.airConditioningType);
    if (prop.heatingSystemType) heatingSystemSelect.value = String(prop.heatingSystemType);
    // New advanced fields
    if (prop.roofType) roofTypeSelect.value = String(prop.roofType);
    if (prop.exteriorType) exteriorTypeSelect.value = String(prop.exteriorType);
    if (prop.constructionType) constructionSelect.value = String(prop.constructionType);
    if (prop.foundation) foundationSelect.value = String(prop.foundation);
    if (prop.roofFrame) roofFrameSelect.value = String(prop.roofFrame);
    if (prop.drivewayType) drivewaySelect.value = String(prop.drivewayType);
    if (prop.lotSize) lotSizeInput.value = String(prop.lotSize);

    // Store PropertyData fields that lack dedicated UI/state variables as overrides.
    // These get merged back into the PropertyData during generation for round-trip fidelity.
    const overrideKeys: (keyof PropertyData)[] = [
      // SV structure analysis (CLI-only — no browser source)
      'svStoryCount', 'svStoryConfidence', 'svTextureClass', 'svTextureBlock',
      'svRoofPitch', 'svRoofHeightOverride', 'svSymmetric', 'svPlanShape',
      'svWindowsPerFloor', 'svWindowSpacing', 'svSetbackFeatures',
      // SV vision (VLM Tier 3)
      'svDoorOverride', 'svFeatures', 'svArchitectureLabel', 'svArchitectureStyle',
      'svWallMaterial', 'svRoofMaterial', 'svWallColorDescription', 'svRoofColorDescription',
      'svVlmRoofShape',
      // Mapillary features
      'mapillaryImageUrl', 'mapillaryHeading', 'mapillaryCaptureDate',
      'mapillaryHasDriveway', 'mapillaryHasFence',
      // Satellite footprint, terrain, misc
      'terrainSlope', 'satFootprintWidth', 'satFootprintLength', 'satFootprintConfidence',
      'newConstruction', 'hasPool', 'floorPlanShape', 'osmArchitecture',
    ];
    const overrides: Partial<PropertyData> = {};
    for (const key of overrideKeys) {
      if (prop[key] !== undefined && prop[key] !== null) {
        (overrides as Record<string, unknown>)[key] = prop[key];
      }
    }
    if (Object.keys(overrides).length > 0) {
      importedPropertyOverrides = overrides;
    }

    // Update enrichment panel with restored data
    updateEnrichmentPanel();

    showStatus(`Loaded from JSON: ${addressInput.value || 'unknown address'}`, 'success');
  }

  // ── Generate ──────────────────────────────────────────────────────────
  generateBtn.addEventListener('click', () => { void doGenerate(); });

  /** Read which API sources are enabled from the toggle checkboxes */
  function getEnabledApis(): Set<string> {
    const enabled = new Set<string>();
    controls.querySelectorAll<HTMLInputElement>('#import-api-toggles input[data-api]').forEach(cb => {
      if (cb.checked) enabled.add(cb.dataset['api']!);
    });
    return enabled;
  }

  /** Build PropertyData from current form values and enrichment state.
   *  Shared by doGenerate() and Export JSON. */
  function buildCurrentPropertyData(): PropertyData {
    // Read which API sources are enabled
    const apis = getEnabledApis();
    const useParcl = apis.has('parcl');
    const useSmarty = apis.has('smarty');
    const useGoogle = apis.has('google');  // SV + Solar
    const useMapbox = apis.has('mapbox');
    const useMapillary = apis.has('mapillary');
    const useOsm = apis.has('osm');
    const useElevation = apis.has('elevation');
    const useNlcd = apis.has('nlcd');
    const useHardiness = apis.has('hardiness');
    const useOsmTrees = apis.has('osmtrees');
    const useOverture = apis.has('overture');
    const useWater = apis.has('water');
    const useCanopyHt = apis.has('canopyht');
    const useLandCover = apis.has('landcover');

    const yearVal = parseInt((controls.querySelector('#import-year') as HTMLInputElement).value) || 2000;

    // Alias API data based on toggle state — null when disabled
    const parcl = useParcl ? currentParcl : null;
    const smarty = useSmarty ? currentSmarty : null;
    const osm = useOsm ? currentOSM : null;
    const svColors = useGoogle ? currentSvColors : null;
    const svMeta = useGoogle ? currentSvMeta : null;
    const solar = useGoogle ? currentSolar : null;
    const mbBuilding = useMapbox ? currentMapboxBuilding : null;
    const mlyImage = useMapillary ? currentMapillaryImage : null;
    const mlyFeats = useMapillary ? currentMapillaryFeatures : [];
    const elevGrid = useElevation ? currentElevGrid : null;
    // Wall override — toggle-aware priority chain:
    //   1. Smarty exterior type (assessor data, highest confidence)
    //   2. OSM building:material tag (community-mapped)
    //   3. Satellite detected color (automatic, lowest confidence)
    // Remaining sources (constructionType, SV color) handled by address-pipeline.ts
    let wall: BlockState | undefined;
    if (useSmarty && currentSmarty?.exteriorWalls) {
      wall = mapSmartyExteriorToWall(currentSmarty.exteriorWalls);
    }
    if (!wall && useOsm && currentOSM?.material) {
      wall = mapOSMMaterialToWall(currentOSM.material);
    }
    if (!wall && currentDetectedColor) {
      wall = mapColorToWall(currentDetectedColor);
    }

    // ── Toggle-aware form values ──
    // Form fields are populated by Parcl/Smarty/OSM during lookup.
    // When those APIs are toggled off, use pre-lookup defaults instead
    // so the toggle accurately shows each API's contribution.
    const formStories = parseInt((controls.querySelector('#import-stories') as HTMLInputElement).value) || 2;
    const formSqft = parseInt((controls.querySelector('#import-sqft') as HTMLInputElement).value) || 2000;
    const formBeds = parseInt((controls.querySelector('#import-beds') as HTMLInputElement).value) || 3;
    const formBaths = parseInt((controls.querySelector('#import-baths') as HTMLInputElement).value) || 2;
    const formPropType = propTypeEl.value;

    // Stories: Smarty > OSM levels > Parcl estimate > form default
    const stories = useSmarty && smarty?.storiesNumber ? smarty.storiesNumber
      : useOsm && osm?.levels ? osm.levels
      : useParcl ? formStories
      : preLookupDefaults.stories;
    // sqft: Parcl primary source (form was populated by Parcl)
    const sqft = useParcl ? formSqft : preLookupDefaults.sqft;
    // beds/baths: Parcl primary source
    const bedrooms = useParcl ? formBeds : preLookupDefaults.bedrooms;
    const bathrooms = useParcl ? formBaths : preLookupDefaults.bathrooms;
    // yearBuilt: Parcl primary source
    const yearBuiltVal = useParcl ? yearVal : preLookupDefaults.yearBuilt;
    // propertyType: Parcl primary source
    const propType = useParcl ? formPropType : preLookupDefaults.propertyType;

    const property: PropertyData = {
      address: addressInput.value.trim() || 'Unknown Address',
      stories,
      sqft,
      bedrooms,
      bathrooms,
      yearBuilt: yearBuiltVal,
      propertyType: propType,
      style: selectedStyle,
      floorPlan: currentFloorPlan ?? undefined,
      geocoding: currentGeocoding ?? undefined,
      season: currentSeason,
      newConstruction: parcl?.newConstruction ?? yearVal >= 2020,
      lotSize: parseInt(lotSizeInput.value) || smarty?.lotSqft || undefined,
      exteriorType: exteriorTypeSelect.value || smarty?.exteriorWalls || undefined,
      wallOverride: wall,
      roofType: roofTypeSelect.value || smarty?.roofCover || undefined,
      architectureType: smarty?.structureStyle || undefined,
      detectedColor: currentDetectedColor,
      osmWidth: osm?.widthBlocks,
      osmLength: osm?.lengthBlocks,
      osmLevels: osm?.levels,
      osmMaterial: osm?.material,
      osmRoofShape: osm?.roofShape ? mapOSMRoofShape(osm.roofShape) : undefined,
      osmRoofMaterial: osm?.roofMaterial,
      osmRoofColour: osm?.roofColour,
      osmBuildingColour: osm?.buildingColour,
      osmArchitecture: osm?.tags?.['building:architecture'],
      hasGarage: smarty?.hasGarage,
      // Smarty assessor amenities
      constructionType: constructionSelect.value || smarty?.constructionType || undefined,
      foundation: foundationSelect.value || smarty?.foundation || undefined,
      roofFrame: roofFrameSelect.value || smarty?.roofFrame || undefined,
      hasFireplace: smarty?.hasFireplace || undefined,
      hasDeck: smarty?.hasDeck || undefined,
      smartyHasPorch: smarty?.hasPorch || undefined,
      smartyHasPool: smarty?.hasPool || undefined,
      smartyHasFence: smarty?.hasFence || undefined,
      drivewayType: drivewaySelect.value || smarty?.drivewayType || undefined,
      assessedValue: smarty?.assessedValue || undefined,
      hasPool: currentPoolDetected,
      floorPlanShape: osm?.polygon
        ? analyzePolygonShape(osm.polygon)
        : (currentSatFootprint?.confidence ?? 0) >= 0.6
          ? currentSatFootprint!.shape
          : undefined,
      osmPolygon: osm?.polygon,
      osmInnerPolygons: osm?.innerPolygons,
      // Satellite footprint dimensions (fallback when OSM footprint unavailable)
      satFootprintWidth: currentSatFootprint?.widthMeters,
      satFootprintLength: currentSatFootprint?.lengthMeters,
      satFootprintConfidence: currentSatFootprint?.confidence,
      streetViewUrl: useGoogle ? (currentStreetViewUrl ?? undefined) : undefined,
      streetViewDate: svMeta?.date || undefined,
      // Compute heading from SV camera → building (facade orientation)
      // Falls back to Mapillary compass angle when Google SV is unavailable
      streetViewHeading: svMeta?.location && currentGeocoding
        ? computeBearing(svMeta.location.lat, svMeta.location.lng,
            currentGeocoding.lat, currentGeocoding.lng)
        : mlyImage?.compassAngle,
      // Street View color analysis (browser-side — fills critical sv* fields)
      svWallOverride: svColors?.wallBlock,
      svRoofOverride: svColors ? svColors.roofOverride : undefined,
      svTrimOverride: svColors?.trimBlock,
      // Mapbox building height — corrected for hillside terrain slope
      // (Mapbox reports height from lowest ground point; subtract half the slope
      // to approximate true building height at center)
      mapboxHeight: (() => {
        if (!mbBuilding?.height) return undefined;
        let h = mbBuilding.height;
        if (elevGrid && currentGeocoding) {
          const slope = footprintSlope(
            elevGrid, currentGeocoding.lat, currentGeocoding.lng,
            osm?.widthMeters ?? 15, osm?.lengthMeters ?? 15,
          );
          if (slope > 1) h = Math.max(3, h - slope / 2);
        }
        return h;
      })(),
      mapboxBuildingType: mbBuilding?.buildingType,
      // Google Solar API enrichment (roof geometry + building footprint)
      solarRoofPitch: solar?.primaryPitchDegrees || undefined,
      solarRoofSegments: solar?.roofSegmentCount || undefined,
      solarAzimuthDegrees: solar?.primaryAzimuthDegrees || undefined,
      solarBuildingArea: solar?.buildingFootprintAreaSqm || undefined,
      solarRoofArea: solar?.totalRoofAreaSqm || undefined,
      // Terrain slope (elevation difference across footprint, meters)
      terrainSlope: elevGrid && currentGeocoding
        ? footprintSlope(
            elevGrid, currentGeocoding.lat, currentGeocoding.lng,
            osm?.widthMeters ?? 15, osm?.lengthMeters ?? 15,
          )
        : undefined,
      county: parcl?.county,
      stateAbbreviation: parcl?.stateAbbreviation,
      city: parcl?.city,
      zipCode: parcl?.zipCode,
      ownerOccupied: parcl?.ownerOccupied,
      onMarket: parcl?.onMarket,
      parclPropertyId: parcl?.parclPropertyId,
      yearUncertain,
      bedroomsUncertain,
      // Mapillary enrichment
      mapillaryImageUrl: mlyImage?.thumbUrl,
      mapillaryHeading: mlyImage?.compassAngle,
      mapillaryCaptureDate: mlyImage?.capturedAt
        ? new Date(mlyImage.capturedAt).toISOString() : undefined,
      ...(mlyFeats.length > 0 ? (() => {
        const { hasDriveway, hasFence } = analyzeFeatures(mlyFeats);
        return {
          mapillaryHasDriveway: hasDriveway || undefined,
          mapillaryHasFence: hasFence || undefined,
        };
      })() : {}),
      // Phase 5 P0: vegetation & landscape enrichment
      canopyCoverPct: useNlcd ? currentNlcdCanopy?.canopyCoverPct ?? undefined : undefined,
      hardinessZone: useHardiness ? currentHardiness?.zone ?? undefined : undefined,
      nearbyTrees: useOsmTrees && currentOSMTrees.length > 0 ? currentOSMTrees : undefined,
      // Phase 5 P0: Overture Maps building attributes
      overtureHeight: useOverture ? currentOverture?.height : undefined,
      overtureFloors: useOverture ? currentOverture?.numFloors : undefined,
      overtureRoofShape: useOverture ? currentOverture?.roofShape : undefined,
      // Phase 5 P1: Smarty untapped fields — form inputs override API data
      garageSqft: parseInt(garageSqftInput.value) || smarty?.garageSqft || undefined,
      fireplaceCount: parseInt(fireplaceCountInput.value) || smarty?.fireplaceCount || undefined,
      totalMarketValue: smarty?.totalMarketValue || undefined,
      airConditioningType: acTypeSelect.value || smarty?.airConditioner || undefined,
      heatingSystemType: heatingSystemSelect.value || smarty?.heat || undefined,
      heatingFuelType: heatingFuelSelect.value || smarty?.heatFuelType || undefined,
      totalRooms: parseInt(totalRoomsInput.value) || smarty?.rooms || undefined,
      // Phase 5 P1: water features, canopy height, land cover
      nearbyWater: useWater && currentWater.length > 0 ? currentWater.map(w => ({
        type: w.type, name: w.name, distanceMeters: w.distanceMeters,
      })) : undefined,
      canopyHeightMeters: useCanopyHt ? currentCanopyHeight?.heightMeters ?? undefined : undefined,
      landCoverClass: useLandCover ? currentLandCover?.classValue ?? undefined : undefined,
      landCoverLabel: useLandCover ? currentLandCover?.label ?? undefined : undefined,
    };

    // Merge JSON-imported fields not covered by form/current* state (SV structure,
    // VLM vision, Mapillary features, satellite footprint, terrain, etc.)
    if (importedPropertyOverrides) {
      for (const [key, val] of Object.entries(importedPropertyOverrides)) {
        if (val !== undefined && (property as Record<string, unknown>)[key] === undefined) {
          (property as Record<string, unknown>)[key] = val;
        }
      }
    }

    return property;
  }

  async function doGenerate(): Promise<void> {
    // Ensure SV color analysis has completed before using results
    if (svAnalysisPromise) {
      generateBtn.disabled = true;
      await svAnalysisPromise;
      svAnalysisPromise = null;
      generateBtn.disabled = false;
    }

    const property = buildCurrentPropertyData();

    const options = convertToGenerationOptions(property);
    const grid = generateStructure(options);

    // Show info panel with enrichment data + download JSON button
    infoPanel.hidden = false;
    infoPanel.innerHTML = buildInfoPanelHtml(grid, property, options, currentOSM)
      + '<button class="btn btn-secondary btn-sm" id="import-dl-json" style="margin-top:8px;width:100%;">Download JSON</button>';
    infoPanel.querySelector('#import-dl-json')?.addEventListener('click', () => {
      const blob = new Blob(
        [JSON.stringify({ property, genOptions: options }, null, 2)],
        { type: 'application/json' },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const slug = (property.address || 'export').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
      a.download = `${slug}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    onGenerate(grid, property);
  }
}

/** Escape for HTML attribute values */
function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
