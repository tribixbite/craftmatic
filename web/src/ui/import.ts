/**
 * Import tab — address-to-structure generation.
 * Takes a real estate address, geocodes it, shows satellite imagery,
 * accepts property details, and generates a Minecraft structure.
 */

import type { StructureType, StyleName, RoomType } from '@craft/types/index.js';
import type { GenerationOptions } from '@craft/types/index.js';
import { generateStructure } from '@craft/gen/generator.js';
import { BlockGrid } from '@craft/schem/types.js';
import { geocodeAddress, type GeocodingResult } from '@ui/import-geocoder.js';
import { composeSatelliteView } from '@ui/import-satellite.js';
import { analyzeFloorPlan, type FloorPlanAnalysis } from '@ui/import-floorplan.js';

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
}

/** Style presets with colors — same as generator but with "Auto" option */
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

/** FNV-1a hash for deterministic seed from address string */
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 999999;
}

/** Infer architectural style from year built */
function inferStyle(year: number): StyleName {
  if (year < 1700) return 'medieval';
  if (year < 1850) return 'gothic';
  if (year < 1920) return 'rustic';
  if (year < 1970) return 'fantasy';
  return 'modern';
}

/** Convert property data into GenerationOptions for the core generator */
export function convertToGenerationOptions(prop: PropertyData): GenerationOptions {
  // Determine style
  const style: StyleName = prop.style === 'auto'
    ? inferStyle(prop.yearBuilt)
    : prop.style;

  // Determine structure type
  let type: StructureType = 'house';
  if (prop.propertyType === 'mansion' || prop.sqft > 5000) {
    type = 'castle';
  }

  // Calculate dimensions from sqft
  // sqft / stories gives area per floor
  // Convert to blocks: 1 block ≈ 1 meter ≈ 10.76 sqft
  const areaPerFloor = prop.sqft / prop.stories / 10.76;
  const aspectRatio = prop.floorPlan?.aspectRatio ?? 1.3;

  // width * length = areaPerFloor, width / length = aspectRatio
  // width = sqrt(areaPerFloor * aspectRatio), length = sqrt(areaPerFloor / aspectRatio)
  let width = Math.round(Math.sqrt(areaPerFloor * aspectRatio));
  let length = Math.round(Math.sqrt(areaPerFloor / aspectRatio));

  // Clamp to reasonable Minecraft dimensions
  width = Math.max(10, Math.min(60, width));
  length = Math.max(10, Math.min(60, length));

  // Build room list
  const rooms: RoomType[] = ['foyer', 'living', 'kitchen', 'dining'];

  // Add bedrooms
  for (let i = 0; i < Math.min(prop.bedrooms, 8); i++) {
    rooms.push('bedroom');
  }

  // Add bathrooms
  for (let i = 0; i < Math.min(prop.bathrooms, 6); i++) {
    rooms.push('bathroom');
  }

  // Add utility rooms for larger homes
  if (prop.sqft > 2500) {
    rooms.push('study');
    rooms.push('laundry');
    rooms.push('mudroom');
  }
  if (prop.sqft > 3500) {
    rooms.push('library');
    rooms.push('sunroom');
    rooms.push('pantry');
  }

  // Force rustic for cabin property type
  const finalStyle: StyleName = prop.propertyType === 'cabin' ? 'rustic' : style;

  // Deterministic seed from address
  const seed = fnv1aHash(prop.address);

  return {
    type,
    floors: prop.stories,
    style: finalStyle,
    rooms,
    width,
    length,
    seed,
  };
}

/** Initialize the import tab UI */
export function initImport(
  controls: HTMLElement,
  viewer: HTMLElement,
  onGenerate: (grid: BlockGrid, property: PropertyData) => void,
): void {
  let selectedStyle: StyleName | 'auto' = 'auto';
  let currentFloorPlan: FloorPlanAnalysis | null = null;
  let currentGeocoding: GeocodingResult | null = null;

  controls.innerHTML = `
    <div class="section-title">Import from Address</div>

    <!-- Address lookup -->
    <div class="form-group">
      <label class="form-label">Property Address</label>
      <div class="import-address-row">
        <input id="import-address" type="text" class="form-input" placeholder="123 Main St, City, State ZIP">
        <button id="import-lookup" class="btn btn-secondary btn-sm">Lookup</button>
      </div>
      <div id="import-status" class="import-status" hidden></div>
    </div>

    <!-- Property details form -->
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Stories</label>
        <input id="import-stories" type="number" class="form-input" value="2" min="1" max="8">
      </div>
      <div class="form-group">
        <label class="form-label">Sq. Ft.</label>
        <input id="import-sqft" type="number" class="form-input" value="2000" min="400" max="50000">
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Bedrooms</label>
        <input id="import-beds" type="number" class="form-input" value="3" min="0" max="20">
      </div>
      <div class="form-group">
        <label class="form-label">Bathrooms</label>
        <input id="import-baths" type="number" class="form-input" value="2" min="0" max="15">
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Year Built</label>
        <input id="import-year" type="number" class="form-input" value="2000" min="1600" max="2030">
      </div>
      <div class="form-group">
        <label class="form-label">Type</label>
        <select id="import-proptype" class="form-select">
          <option value="house">House</option>
          <option value="townhouse">Townhouse</option>
          <option value="condo">Condo</option>
          <option value="cabin">Cabin</option>
          <option value="mansion">Mansion</option>
        </select>
      </div>
    </div>

    <!-- Style chips -->
    <div class="form-group">
      <label class="form-label">Style</label>
      <div id="import-style-chips" style="display:flex;gap:6px;flex-wrap:wrap;">
        ${STYLE_PRESETS.map(s => `
          <button class="style-chip ${s.value === 'auto' ? 'active' : ''}" data-style="${s.value}"
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
          <p style="color:var(--text-muted);font-size:12px;">Drop floor plan image here or click to browse</p>
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

  // DOM refs
  const addressInput = controls.querySelector('#import-address') as HTMLInputElement;
  const lookupBtn = controls.querySelector('#import-lookup') as HTMLButtonElement;
  const statusEl = controls.querySelector('#import-status') as HTMLElement;
  const generateBtn = controls.querySelector('#import-generate') as HTMLButtonElement;
  const infoPanel = controls.querySelector('#import-info') as HTMLElement;
  const floorPlanDrop = controls.querySelector('#import-floorplan-drop') as HTMLElement;
  const floorPlanInput = controls.querySelector('#import-floorplan-input') as HTMLInputElement;
  const floorPlanInfo = controls.querySelector('#import-floorplan-info') as HTMLElement;

  // ── Style chips ───────────────────────────────────────────────────────
  const chips = controls.querySelectorAll('.style-chip');
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedStyle = (chip as HTMLElement).dataset['style'] as StyleName | 'auto';
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

    showStatus('Geocoding...', 'loading');
    lookupBtn.disabled = true;

    try {
      const result = await geocodeAddress(address);
      currentGeocoding = result;
      showStatus(`${result.matchedAddress} (${result.source})`, 'success');

      // Load satellite view into the viewer panel
      showSatelliteLoading(viewer);
      const canvas = await composeSatelliteView(result.lat, result.lng);
      showSatelliteCanvas(viewer, canvas, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Geocoding failed';
      showStatus(msg, 'error');
      currentGeocoding = null;
    } finally {
      lookupBtn.disabled = false;
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

  function showSatelliteCanvas(container: HTMLElement, canvas: HTMLCanvasElement, geo: GeocodingResult): void {
    container.innerHTML = '';

    // Satellite canvas wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'import-satellite-wrapper';

    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.objectFit = 'contain';
    wrapper.appendChild(canvas);

    // Lat/lng overlay
    const overlay = document.createElement('div');
    overlay.className = 'import-satellite-overlay';
    overlay.textContent = `${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}`;
    wrapper.appendChild(overlay);

    container.appendChild(wrapper);
  }

  // ── Floor plan upload ─────────────────────────────────────────────────
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

        // Update drop zone to show loaded state
        floorPlanDrop.innerHTML = `<p style="color:var(--success);font-size:12px;">Floor plan loaded: ${file.name}</p>`;
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }

  // ── Generate ──────────────────────────────────────────────────────────
  generateBtn.addEventListener('click', doGenerate);

  function doGenerate(): void {
    const property: PropertyData = {
      address: addressInput.value.trim() || 'Unknown Address',
      stories: parseInt((controls.querySelector('#import-stories') as HTMLInputElement).value) || 2,
      sqft: parseInt((controls.querySelector('#import-sqft') as HTMLInputElement).value) || 2000,
      bedrooms: parseInt((controls.querySelector('#import-beds') as HTMLInputElement).value) || 3,
      bathrooms: parseInt((controls.querySelector('#import-baths') as HTMLInputElement).value) || 2,
      yearBuilt: parseInt((controls.querySelector('#import-year') as HTMLInputElement).value) || 2000,
      propertyType: (controls.querySelector('#import-proptype') as HTMLSelectElement).value,
      style: selectedStyle,
      floorPlan: currentFloorPlan ?? undefined,
      geocoding: currentGeocoding ?? undefined,
    };

    const options = convertToGenerationOptions(property);
    const grid = generateStructure(options);

    // Show info panel
    const nonAir = grid.countNonAir();
    infoPanel.hidden = false;
    infoPanel.innerHTML = `
      <div class="info-row"><span class="info-label">Address</span><span class="info-value" style="font-family:var(--font);font-size:11px;">${escapeHtml(property.address)}</span></div>
      <div class="info-row"><span class="info-label">Dimensions</span><span class="info-value">${grid.width} x ${grid.height} x ${grid.length}</span></div>
      <div class="info-row"><span class="info-label">Blocks</span><span class="info-value">${nonAir.toLocaleString()}</span></div>
      <div class="info-row"><span class="info-label">Style</span><span class="info-value">${options.style}</span></div>
      <div class="info-row"><span class="info-label">Rooms</span><span class="info-value">${options.rooms?.length ?? 0}</span></div>
    `;

    onGenerate(grid, property);
  }
}

/** Escape HTML to prevent XSS in address display */
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
