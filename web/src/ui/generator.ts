/**
 * Structure generator UI panel.
 * Provides controls for type, style, floors, dimensions, and seed.
 */

import type { StructureType, StyleName } from '@craft/types/index.js';
import { generateStructure } from '@craft/gen/generator.js';
import { BlockGrid } from '@craft/schem/types.js';

export interface GeneratorConfig {
  type: StructureType;
  style: StyleName;
  floors: number;
  width?: number;
  length?: number;
  seed?: number;
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
  { value: 'steampunk', label: 'Steampunk', color: '#cd7f32' },
  { value: 'elven', label: 'Elven', color: '#7cbb5f' },
  { value: 'desert', label: 'Desert', color: '#deb887' },
  { value: 'underwater', label: 'Underwater', color: '#5f9ea0' },
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

  // Generate button
  const genBtn = container.querySelector('#gen-btn') as HTMLButtonElement;
  const randomBtn = container.querySelector('#gen-random-btn') as HTMLButtonElement;
  const infoPanel = container.querySelector('#gen-info') as HTMLElement;

  function doGenerate(randomize = false): void {
    const config: GeneratorConfig = {
      type: typeSelect.value as StructureType,
      style: randomize ? STYLE_PRESETS[Math.floor(Math.random() * STYLE_PRESETS.length)].value : selectedStyle,
      floors: parseInt((container.querySelector('#gen-floors') as HTMLInputElement).value) || 2,
      seed: randomize ? Math.floor(Math.random() * 999999) : (parseInt((container.querySelector('#gen-seed') as HTMLInputElement).value) || undefined),
      width: parseInt((container.querySelector('#gen-width') as HTMLInputElement).value) || undefined,
      length: parseInt((container.querySelector('#gen-length') as HTMLInputElement).value) || undefined,
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

    const grid = generateStructure({
      type: config.type,
      floors: config.floors,
      style: config.style,
      width: config.width,
      length: config.length,
      seed: config.seed,
    });

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
  }

  genBtn.addEventListener('click', () => doGenerate(false));
  randomBtn.addEventListener('click', () => doGenerate(true));

  // Collapse/expand options panel
  const collapseBtn = container.querySelector('#gen-collapse-btn') as HTMLButtonElement;
  const optionsBody = container.querySelector('#gen-options-body') as HTMLElement;
  collapseBtn.addEventListener('click', () => {
    const collapsed = optionsBody.classList.toggle('collapsed');
    collapseBtn.classList.toggle('collapsed', collapsed);
  });
}
