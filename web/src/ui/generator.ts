/**
 * Structure generator UI panel.
 * Provides controls for type, style, floors, dimensions, seed, roof shape,
 * floor plan, features, and JSON import/export.
 */

import type {
  StructureType, StyleName, RoofShape, FloorPlanShape, FeatureFlags,
  GenerationOptions,
} from '@craft/types/index.js';
import { generateStructure } from '@craft/gen/generator.js';
import { BlockGrid } from '@craft/schem/types.js';

export interface GeneratorConfig {
  type: StructureType;
  style: StyleName;
  floors: number;
  width?: number;
  length?: number;
  seed?: number;
  wallOverride?: string;
  trimOverride?: string;
  doorOverride?: string;
  roofShape?: RoofShape;
  floorPlanShape?: FloorPlanShape;
  windowSpacing?: number;
  roofHeightOverride?: number;
  season?: 'snow' | 'spring' | 'summer' | 'fall';
  features?: FeatureFlags;
}

const STRUCTURE_TYPES: { value: StructureType; label: string; desc: string }[] = [
  { value: 'house', label: 'House', desc: 'Multi-story residential with rooms and porch' },
  { value: 'tower', label: 'Tower', desc: 'Circular tower with spiral staircase' },
  { value: 'castle', label: 'Castle', desc: 'Curtain walls, corner towers, and central keep' },
  { value: 'dungeon', label: 'Dungeon', desc: 'Underground chambers with gatehouse entrance' },
  { value: 'ship', label: 'Ship', desc: 'Sailing vessel with hull, masts, and cabins' },
  { value: 'cathedral', label: 'Cathedral', desc: 'Grand nave with apse, rose window, and bell tower' },
  { value: 'bridge', label: 'Bridge', desc: 'Arched stone span with end towers' },
  { value: 'windmill', label: 'Windmill', desc: 'Circular tapering tower with rotating blades' },
  { value: 'marketplace', label: 'Marketplace', desc: 'Open-air stall grid with central well' },
  { value: 'village', label: 'Village', desc: 'Multiple buildings with paths and landscaping' },
];

const STYLE_PRESETS: { value: StyleName; label: string; color: string }[] = [
  { value: 'fantasy', label: 'Fantasy', color: '#b19cd9' },
  { value: 'medieval', label: 'Medieval', color: '#c9a96e' },
  { value: 'modern', label: 'Modern', color: '#87ceeb' },
  { value: 'gothic', label: 'Gothic', color: '#cc4444' },
  { value: 'rustic', label: 'Rustic', color: '#8b7355' },
  { value: 'colonial', label: 'Colonial', color: '#f5f0e1' },
  { value: 'steampunk', label: 'Steampunk', color: '#cd7f32' },
  { value: 'elven', label: 'Elven', color: '#7cbb5f' },
  { value: 'desert', label: 'Desert', color: '#deb887' },
  { value: 'underwater', label: 'Underwater', color: '#5f9ea0' },
];

const FEATURE_DEFS: { key: keyof FeatureFlags; label: string }[] = [
  { key: 'chimney', label: 'Chimney' },
  { key: 'porch', label: 'Porch' },
  { key: 'backyard', label: 'Backyard' },
  { key: 'driveway', label: 'Driveway' },
  { key: 'fence', label: 'Fence' },
  { key: 'trees', label: 'Trees' },
  { key: 'garden', label: 'Garden' },
  { key: 'pool', label: 'Pool' },
  { key: 'deck', label: 'Deck' },
];

/** Initialize the generator controls UI */
export function initGenerator(
  container: HTMLElement,
  onGenerate: (grid: BlockGrid, config: GeneratorConfig) => void,
): void {
  container.innerHTML = `
    <div class="gen-options-header" id="gen-toggle">
      <div class="section-title" style="border:none;padding:0;">Structure Generator</div>
      <button class="gen-collapse-btn" id="gen-collapse-btn" title="Toggle options">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
    </div>

    <div class="gen-options-body" id="gen-options-body">
      <div class="form-group">
        <label class="form-label">Type</label>
        <select id="gen-type" class="form-select">
          ${STRUCTURE_TYPES.map(t => `<option value="${t.value}">${t.label}</option>`).join('')}
        </select>
        <div id="gen-type-desc" class="form-hint" style="font-size:11px;color:var(--text-muted);margin-top:2px;">
          ${STRUCTURE_TYPES[0].desc}
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Style</label>
        <div id="gen-style-chips" style="display:flex;gap:6px;flex-wrap:wrap;">
          ${STYLE_PRESETS.map(s => `
            <button class="style-chip ${s.value === 'fantasy' ? 'active' : ''}" data-style="${s.value}"
                    style="--chip-color:${s.color};">
              ${s.label}
            </button>
          `).join('')}
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Floors</label>
          <input id="gen-floors" type="number" class="form-input" value="2" min="1" max="8">
        </div>
        <div class="form-group">
          <label class="form-label">Seed</label>
          <input id="gen-seed" type="number" class="form-input" placeholder="Random">
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Width</label>
          <input id="gen-width" type="number" class="form-input" placeholder="Auto">
        </div>
        <div class="form-group">
          <label class="form-label">Length</label>
          <input id="gen-length" type="number" class="form-input" placeholder="Auto">
        </div>
      </div>

      <details class="customize-section" id="gen-customize">
        <summary class="customize-summary">Customize Colors</summary>
        <div class="customize-body">
          <div class="form-group">
            <label class="form-label">House Color</label>
            <select id="gen-wall" class="form-select">
              <option value="">Default (from style)</option>
              <option value="minecraft:white_concrete">White Concrete</option>
              <option value="minecraft:stone_bricks">Stone Bricks</option>
              <option value="minecraft:bricks">Bricks</option>
              <option value="minecraft:oak_planks">Oak Planks</option>
              <option value="minecraft:spruce_planks">Spruce Planks</option>
              <option value="minecraft:birch_planks">Birch Planks</option>
              <option value="minecraft:dark_oak_planks">Dark Oak Planks</option>
              <option value="minecraft:sandstone">Sandstone</option>
              <option value="minecraft:terracotta">Terracotta</option>
              <option value="minecraft:iron_block">Iron Block</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Trim Color</label>
            <select id="gen-trim" class="form-select">
              <option value="">Default (from style)</option>
              <option value="minecraft:dark_oak_log">Dark Oak Log</option>
              <option value="minecraft:oak_log">Oak Log</option>
              <option value="minecraft:spruce_log">Spruce Log</option>
              <option value="minecraft:birch_log">Birch Log</option>
              <option value="minecraft:stone_bricks">Stone Bricks</option>
              <option value="minecraft:deepslate_bricks">Deepslate Bricks</option>
              <option value="minecraft:quartz_pillar">Quartz Pillar</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Door</label>
            <select id="gen-door" class="form-select">
              <option value="">Default (from style)</option>
              <option value="oak">Oak</option>
              <option value="spruce">Spruce</option>
              <option value="birch">Birch</option>
              <option value="dark_oak">Dark Oak</option>
              <option value="acacia">Acacia</option>
              <option value="crimson">Crimson</option>
              <option value="warped">Warped</option>
              <option value="iron">Iron</option>
            </select>
          </div>
        </div>
      </details>

      <details class="customize-section" id="gen-advanced">
        <summary class="customize-summary">Advanced Options</summary>
        <div class="customize-body">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Roof Shape</label>
              <select id="gen-roof-shape" class="form-select">
                <option value="">Auto</option>
                <option value="gable">Gable</option>
                <option value="hip">Hip</option>
                <option value="flat">Flat</option>
                <option value="gambrel">Gambrel</option>
                <option value="mansard">Mansard</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Floor Plan</label>
              <select id="gen-floorplan" class="form-select">
                <option value="">Auto</option>
                <option value="rect">Rectangular</option>
                <option value="L">L-Shape</option>
                <option value="T">T-Shape</option>
                <option value="U">U-Shape</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Window Spacing</label>
              <input id="gen-window-spacing" type="number" class="form-input" placeholder="Auto" min="2" max="6">
            </div>
            <div class="form-group">
              <label class="form-label">Roof Height</label>
              <input id="gen-roof-height" type="number" class="form-input" placeholder="Auto" min="1" max="12">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Season</label>
              <select id="gen-season" class="form-select">
                <option value="">None</option>
                <option value="snow">Winter</option>
                <option value="spring">Spring</option>
                <option value="summer">Summer</option>
                <option value="fall">Autumn</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Foundation</label>
              <select id="gen-foundation" class="form-select">
                <option value="">Default</option>
                <option value="slab">Slab</option>
                <option value="crawlspace">Crawlspace</option>
                <option value="basement">Basement</option>
                <option value="pier">Pier</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" style="margin-bottom:4px;">Features</label>
            <div id="gen-features" style="display:flex;flex-wrap:wrap;gap:4px 10px;">
              ${FEATURE_DEFS.map(f => `
                <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text-secondary);cursor:pointer;">
                  <input type="checkbox" data-feature="${f.key}">
                  ${f.label}
                </label>
              `).join('')}
            </div>
            <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">Unchecked = generator default</div>
          </div>
        </div>
      </details>
    </div>

    <div class="gen-actions">
      <div class="divider"></div>

      <button id="gen-btn" class="btn btn-primary btn-full">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
        Generate
      </button>

      <button id="gen-random-btn" class="btn btn-secondary btn-full btn-sm">
        Randomize & Generate
      </button>

      <div style="display:flex;gap:6px;margin-top:4px;">
        <button id="gen-import-json" class="btn btn-secondary btn-sm" style="flex:1;">
          Import JSON
        </button>
        <button id="gen-export-json" class="btn btn-secondary btn-sm" style="flex:1;">
          Export JSON
        </button>
      </div>
      <input type="file" id="gen-json-file" accept=".json,application/json" hidden>

      <div id="gen-info" class="info-panel" hidden></div>
    </div>
  `;

  // Type selector — update description
  const typeSelect = container.querySelector('#gen-type') as HTMLSelectElement;
  const typeDesc = container.querySelector('#gen-type-desc') as HTMLElement;
  typeSelect.addEventListener('change', () => {
    const t = STRUCTURE_TYPES.find(t => t.value === typeSelect.value);
    if (t) typeDesc.textContent = t.desc;
  });

  // Style chips
  let selectedStyle: StyleName = 'fantasy';
  const chips = container.querySelectorAll('.style-chip');
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedStyle = (chip as HTMLElement).dataset['style'] as StyleName;
    });
  });

  // DOM refs
  const genBtn = container.querySelector('#gen-btn') as HTMLButtonElement;
  const randomBtn = container.querySelector('#gen-random-btn') as HTMLButtonElement;
  const infoPanel = container.querySelector('#gen-info') as HTMLElement;
  const roofShapeSel = container.querySelector('#gen-roof-shape') as HTMLSelectElement;
  const floorPlanSel = container.querySelector('#gen-floorplan') as HTMLSelectElement;
  const windowSpacingInput = container.querySelector('#gen-window-spacing') as HTMLInputElement;
  const roofHeightInput = container.querySelector('#gen-roof-height') as HTMLInputElement;
  const seasonSel = container.querySelector('#gen-season') as HTMLSelectElement;
  const foundationSel = container.querySelector('#gen-foundation') as HTMLSelectElement;
  const importJsonBtn = container.querySelector('#gen-import-json') as HTMLButtonElement;
  const exportJsonBtn = container.querySelector('#gen-export-json') as HTMLButtonElement;
  const jsonFileInput = container.querySelector('#gen-json-file') as HTMLInputElement;

  /** Read feature checkboxes — returns only explicitly checked features */
  function readFeatures(): FeatureFlags | undefined {
    const features: FeatureFlags = {};
    let hasAny = false;
    container.querySelectorAll<HTMLInputElement>('#gen-features input[data-feature]').forEach(cb => {
      if (cb.checked) {
        (features as Record<string, boolean>)[cb.dataset['feature']!] = true;
        hasAny = true;
      }
    });
    // Foundation type
    if (foundationSel.value) {
      features.foundationType = foundationSel.value as FeatureFlags['foundationType'];
      hasAny = true;
    }
    return hasAny ? features : undefined;
  }

  /** Build current GeneratorConfig from UI state */
  function buildConfig(randomize = false): GeneratorConfig {
    const wallSel = container.querySelector('#gen-wall') as HTMLSelectElement;
    const trimSel = container.querySelector('#gen-trim') as HTMLSelectElement;
    const doorSel = container.querySelector('#gen-door') as HTMLSelectElement;

    const config: GeneratorConfig = {
      type: typeSelect.value as StructureType,
      style: randomize ? STYLE_PRESETS[Math.floor(Math.random() * STYLE_PRESETS.length)].value : selectedStyle,
      floors: parseInt((container.querySelector('#gen-floors') as HTMLInputElement).value) || 2,
      seed: randomize ? Math.floor(Math.random() * 999999) : (parseInt((container.querySelector('#gen-seed') as HTMLInputElement).value) || undefined),
      width: parseInt((container.querySelector('#gen-width') as HTMLInputElement).value) || undefined,
      length: parseInt((container.querySelector('#gen-length') as HTMLInputElement).value) || undefined,
      wallOverride: wallSel.value || undefined,
      trimOverride: trimSel.value || undefined,
      doorOverride: doorSel.value || undefined,
      roofShape: (roofShapeSel.value as RoofShape) || undefined,
      floorPlanShape: (floorPlanSel.value as FloorPlanShape) || undefined,
      windowSpacing: parseInt(windowSpacingInput.value) || undefined,
      roofHeightOverride: parseInt(roofHeightInput.value) || undefined,
      season: (seasonSel.value as GeneratorConfig['season']) || undefined,
      features: readFeatures(),
    };

    if (randomize) {
      config.type = STRUCTURE_TYPES[Math.floor(Math.random() * STRUCTURE_TYPES.length)].value;
      config.floors = 1 + Math.floor(Math.random() * 4);
      // Update UI to reflect random choices
      typeSelect.value = config.type;
      (container.querySelector('#gen-floors') as HTMLInputElement).value = String(config.floors);
      (container.querySelector('#gen-seed') as HTMLInputElement).value = String(config.seed);
      chips.forEach(c => {
        c.classList.toggle('active', (c as HTMLElement).dataset['style'] === config.style);
      });
      selectedStyle = config.style;
      const t = STRUCTURE_TYPES.find(t => t.value === config.type);
      if (t) typeDesc.textContent = t.desc;
    }

    return config;
  }

  function doGenerate(randomize = false): void {
    const config = buildConfig(randomize);

    const genOpts: GenerationOptions = {
      type: config.type,
      floors: config.floors,
      style: config.style,
      width: config.width,
      length: config.length,
      seed: config.seed,
      wallOverride: config.wallOverride,
      trimOverride: config.trimOverride,
      doorOverride: config.doorOverride,
      roofShape: config.roofShape,
      floorPlanShape: config.floorPlanShape,
      windowSpacing: config.windowSpacing,
      roofHeightOverride: config.roofHeightOverride,
      season: config.season,
      features: config.features,
    };

    const grid = generateStructure(genOpts);

    // Show info
    const nonAir = grid.countNonAir();
    infoPanel.hidden = false;
    infoPanel.innerHTML = `
      <div class="info-row"><span class="info-label">Dimensions</span><span class="info-value">${grid.width} x ${grid.height} x ${grid.length}</span></div>
      <div class="info-row"><span class="info-label">Blocks</span><span class="info-value">${nonAir.toLocaleString()}</span></div>
      <div class="info-row"><span class="info-label">Palette</span><span class="info-value">${grid.palette.size} materials</span></div>
      <div class="info-row"><span class="info-label">Entities</span><span class="info-value">${grid.blockEntities.length}</span></div>
    `;

    onGenerate(grid, config);

    // Auto-collapse options after generating to maximize viewer space on mobile
    optionsBody.classList.add('collapsed');
    collapseBtn.classList.add('collapsed');
  }

  // Collapse/expand options panel
  const collapseBtn = container.querySelector('#gen-collapse-btn') as HTMLButtonElement;
  const optionsBody = container.querySelector('#gen-options-body') as HTMLElement;
  collapseBtn.addEventListener('click', () => {
    const collapsed = optionsBody.classList.toggle('collapsed');
    collapseBtn.classList.toggle('collapsed', collapsed);
  });

  genBtn.addEventListener('click', () => doGenerate(false));
  randomBtn.addEventListener('click', () => doGenerate(true));

  // ── JSON Export ──
  exportJsonBtn.addEventListener('click', () => {
    const config = buildConfig();
    const blob = new Blob(
      [JSON.stringify(config, null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `craftmatic-${config.type}-${config.style}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── JSON Import ──
  /** Populate UI from imported JSON config */
  function populateFromConfig(json: Record<string, unknown>): void {
    // Accept GenerationOptions or GeneratorConfig format
    if (json.type && typeof json.type === 'string') {
      typeSelect.value = json.type as string;
      const t = STRUCTURE_TYPES.find(t => t.value === json.type);
      if (t) typeDesc.textContent = t.desc;
    }
    if (json.style && typeof json.style === 'string') {
      selectedStyle = json.style as StyleName;
      chips.forEach(c => {
        c.classList.toggle('active', (c as HTMLElement).dataset['style'] === selectedStyle);
      });
    }
    if (json.floors != null) {
      (container.querySelector('#gen-floors') as HTMLInputElement).value = String(json.floors);
    }
    if (json.seed != null) {
      (container.querySelector('#gen-seed') as HTMLInputElement).value = String(json.seed);
    }
    if (json.width != null) {
      (container.querySelector('#gen-width') as HTMLInputElement).value = String(json.width);
    }
    if (json.length != null) {
      (container.querySelector('#gen-length') as HTMLInputElement).value = String(json.length);
    }
    // Color overrides
    const wallSel = container.querySelector('#gen-wall') as HTMLSelectElement;
    const trimSel = container.querySelector('#gen-trim') as HTMLSelectElement;
    const doorSel = container.querySelector('#gen-door') as HTMLSelectElement;
    if (json.wallOverride) wallSel.value = String(json.wallOverride);
    if (json.trimOverride) trimSel.value = String(json.trimOverride);
    if (json.doorOverride) doorSel.value = String(json.doorOverride);
    // Advanced options
    if (json.roofShape) roofShapeSel.value = String(json.roofShape);
    if (json.floorPlanShape) floorPlanSel.value = String(json.floorPlanShape);
    if (json.windowSpacing != null) windowSpacingInput.value = String(json.windowSpacing);
    if (json.roofHeightOverride != null) roofHeightInput.value = String(json.roofHeightOverride);
    if (json.season) seasonSel.value = String(json.season);
    // Feature flags
    if (json.features && typeof json.features === 'object') {
      const feats = json.features as Record<string, unknown>;
      container.querySelectorAll<HTMLInputElement>('#gen-features input[data-feature]').forEach(cb => {
        cb.checked = !!feats[cb.dataset['feature']!];
      });
      if (feats.foundationType) foundationSel.value = String(feats.foundationType);
    }
  }

  importJsonBtn.addEventListener('click', () => {
    const text = prompt('Paste JSON here, or cancel to use file picker:');
    if (text && text.trim()) {
      try {
        populateFromConfig(JSON.parse(text));
      } catch {
        // invalid JSON — ignore
      }
    } else if (text === null) {
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
        // Support { genOptions: {...} } wrapper from comparison/import exports
        populateFromConfig(json.genOptions ?? json);
      } catch {
        // invalid JSON file — ignore
      }
    };
    reader.readAsText(file);
    jsonFileInput.value = '';
  });
}
