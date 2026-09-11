/**
 * Minecraft-export settings popover (S4) — shared by every export surface.
 *
 * One tiny gear button next to a Download control; clicking it opens a fixed
 * popover positioned from the button's rect (so it can't be clipped by the
 * LEGO tab's scrolling control panel or the inline viewer's overlay bar).
 *
 * Settings live in module state, persisted to localStorage, and are read by
 * `ui/schem-export.ts` at export time — so both tabs always agree, and a value
 * chosen on one surface applies to the other.
 *
 * Resolution is only meaningful when the export voxelizes something (the LEGO
 * tab). An uploaded .schem/.litematic/mesh is ALREADY a grid of blocks; there
 * is no finer detail to recover, so that row renders disabled with the reason.
 */

import {
  DEFAULT_SCHEM_SETTINGS, RESOLUTION_OPTIONS, describePlan, planResolution,
  type ResolutionChoice, type SchemExportSettings, type SpanLDU,
} from '@engine/schem-settings.js';
import { BLOCK_PROFILES } from '@engine/block-profiles.js';

const STORAGE_KEY = 'craftmatic.mcExportSettings';
const STYLE_ID = 'mc-export-settings-style';

let settings: SchemExportSettings = { ...DEFAULT_SCHEM_SETTINGS };
let loaded = false;

function load(): SchemExportSettings {
  if (loaded) return settings;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SchemExportSettings>;
      const res = parsed.resolution;
      settings = {
        resolution: RESOLUTION_OPTIONS.some(o => o.value === res) ? res as ResolutionChoice : 'auto',
        profile: BLOCK_PROFILES.some(p => p.id === parsed.profile) ? parsed.profile! : DEFAULT_SCHEM_SETTINGS.profile,
        lightFill: parsed.lightFill === true,
        vehicleFacing: ['+x', '-x', '+z', '-z'].includes(parsed.vehicleFacing ?? '') ? parsed.vehicleFacing : 'auto',
        lightCoverage: parsed.lightCoverage === 'covered' ? 'covered' : 'sealed',
        lightStyle: ['lantern', 'sea_lantern'].includes(parsed.lightStyle ?? '') ? parsed.lightStyle : 'profile',
        lightSpacing: [3, 6, 10].includes(parsed.lightSpacing ?? 0) ? parsed.lightSpacing : 6,
        // Default ON, so a value stored before the setting existed opts in.
        shapes: parsed.shapes !== false,
      };
    }
  } catch { /* private mode / corrupt value → defaults */ }
  return settings;
}

/** Current export settings (defaults until the user changes something). */
export function getSchemSettings(): SchemExportSettings {
  return { lightCoverage: 'covered', lightStyle: 'profile', lightSpacing: 6, ...load() };
}

function save(next: SchemExportSettings): void {
  settings = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

const CSS = `
.mc-set-btn {
  font-size: 0.7rem; padding: 2px 6px; border-radius: 3px; cursor: pointer;
  background: transparent; color: inherit; border: 1px solid rgba(255,255,255,0.25);
  font-family: inherit; line-height: 1.4;
}
.mc-set-btn:hover { border-color: rgba(255,255,255,0.5); }
.mc-set-pop {
  position: fixed; z-index: 10001; display: none;
  width: 290px; max-width: calc(100vw - 20px);
  max-height: calc(100vh - 16px); overflow-y: auto;
  box-sizing: border-box; padding: 10px 12px 12px;
  background: rgba(20, 22, 30, 0.98); color: #e8e8ef;
  border: 1px solid rgba(255,255,255,0.16); border-radius: 6px;
  box-shadow: 0 8px 26px rgba(0,0,0,0.5);
  font: 400 0.75rem/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.mc-set-pop.is-open { display: block; }
.mc-set-pop h4 { margin: 0 0 8px; font-size: 0.78rem; font-weight: 600; }
.mc-set-field { margin-bottom: 9px; }
.mc-set-field > label { display: block; margin-bottom: 3px; opacity: 0.82; }
.mc-set-field select { width: 100%; font: inherit; font-size: 0.72rem; padding: 3px 4px; border-radius: 3px; }
.mc-set-field select:disabled { opacity: 0.5; }
.mc-set-check { display: flex; align-items: flex-start; gap: 6px; cursor: pointer; }
.mc-set-check input { margin: 2px 0 0; }
.mc-set-note { margin: 4px 0 0; opacity: 0.62; font-size: 0.68rem; }
.mc-set-preview { margin-top: 2px; font-size: 0.69rem; opacity: 0.8; font-variant-numeric: tabular-nums; }
`;

export interface SchemSettingsMountOptions {
  /** False for already-voxelized sources (Upload tab) — the row renders disabled. */
  resolutionApplicable: boolean;
  /** Model extent for the live dims preview (LEGO tab). Null = nothing loaded. */
  getSpan?: () => SpanLDU | null;
  /** Button label. Default "⚙ MC settings". */
  label?: string;
  /**
   * Identity for a surface that re-renders (the inline viewer rebuilds its
   * control bar on every load). Mounting the same key tears the previous
   * popover + listeners down instead of leaking one per model.
   */
  key?: string;
}

/** Live mounts by key, so a re-mount can dispose its predecessor. */
const mounts = new Map<string, { pop: HTMLElement; ac: AbortController }>();

export interface SchemSettingsHandle {
  /** Re-read the span and refresh the dims preview (call after a model loads). */
  refresh(): void;
}

/**
 * Render the gear button + popover into `host`. Returns a handle whose
 * `refresh()` updates the live dims preview after a new model loads.
 */
export function mountSchemSettings(host: HTMLElement, opts: SchemSettingsMountOptions): SchemSettingsHandle {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  if (opts.key) {
    const prev = mounts.get(opts.key);
    if (prev) { prev.ac.abort(); prev.pop.remove(); mounts.delete(opts.key); }
  }
  const ac = new AbortController();
  const sig = { signal: ac.signal };

  const current = load();

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mc-set-btn';
  btn.title = 'Minecraft export settings — resolution, block mapping, interior lights';
  btn.textContent = opts.label ?? '⚙ MC settings';

  const pop = document.createElement('div');
  pop.className = 'mc-set-pop';
  pop.innerHTML = `
    <h4>Minecraft export</h4>
    <div class="mc-set-field">
      <label for="mc-set-res">Resolution</label>
      <select id="mc-set-res">
        ${RESOLUTION_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
      </select>
      <div class="mc-set-preview" data-role="preview"></div>
    </div>
    <div class="mc-set-field">
      <label for="mc-set-profile">Block mapping</label>
      <select id="mc-set-profile">
        ${BLOCK_PROFILES.map(p => `<option value="${p.id}">${p.label}</option>`).join('')}
      </select>
      <p class="mc-set-note" data-role="profile-note"></p>
    </div>
    <div class="mc-set-field">
      <label class="mc-set-check">
        <input type="checkbox" id="mc-set-shapes">
        <span>Block shapes<br>
          <span class="mc-set-note">Uses slabs and stairs where a plate or slope is genuinely half a block. Only refines blocks that are already solid — never removes any. Vanilla has no dyed slab, so with the default mapping only sandstone bricks can take one; the “Textured + shapes” mapping above is what unlocks the rest.</span>
        </span>
      </label>
    </div>
    <div class="mc-set-field">
      <label class="mc-set-check">
        <input type="checkbox" id="mc-set-light">
        <span>Light interiors<br>
          <span class="mc-set-note">Add lamps without replacing model blocks. Enable for dark builds.</span>
        </span>
      </label>
    </div>
    <div class="mc-set-field">
      <label for="mc-set-vehicle-facing">Vehicle front (playable add-on)</label>
      <select id="mc-set-vehicle-facing"><option value="auto">Auto - detected model orientation</option><option value="+x">+X</option><option value="-x">-X</option><option value="+z">+Z</option><option value="-z">-Z</option></select>
      <p class="mc-set-note">For a car that drives backward, choose the opposite direction and export again.</p>
      <label for="mc-set-light-coverage">Lighting coverage</label>
      <select id="mc-set-light-coverage"><option value="covered">Covered interiors, including open fronts</option><option value="sealed">Sealed rooms only</option></select>
      <label for="mc-set-light-style">Lamp style</label>
      <select id="mc-set-light-style"><option value="profile">Match block mapping</option><option value="lantern">Warm lanterns</option><option value="sea_lantern">Bright sea lanterns</option></select>
      <label for="mc-set-light-spacing">Lamp spacing</label>
      <select id="mc-set-light-spacing"><option value="3">Dense - every 3 blocks</option><option value="6">Balanced - every 6 blocks</option><option value="10">Sparse - every 10 blocks</option></select>
    </div>
  `;

  host.appendChild(btn);
  document.body.appendChild(pop);

  const resSel = pop.querySelector('#mc-set-res') as HTMLSelectElement;
  const profSel = pop.querySelector('#mc-set-profile') as HTMLSelectElement;
  const lightBox = pop.querySelector('#mc-set-light') as HTMLInputElement;
  const facingSel = pop.querySelector('#mc-set-vehicle-facing') as HTMLSelectElement;
  const coverageSel = pop.querySelector('#mc-set-light-coverage') as HTMLSelectElement;
  const styleSel = pop.querySelector('#mc-set-light-style') as HTMLSelectElement;
  const spacingSel = pop.querySelector('#mc-set-light-spacing') as HTMLSelectElement;
  const syncLights = (s: SchemExportSettings): void => { facingSel.value = s.vehicleFacing ?? 'auto'; coverageSel.value = s.lightCoverage ?? 'covered'; styleSel.value = s.lightStyle ?? 'profile'; spacingSel.value = String(s.lightSpacing ?? 6); };
  syncLights(current);
  const shapeBox = pop.querySelector('#mc-set-shapes') as HTMLInputElement;
  const preview = pop.querySelector('[data-role="preview"]') as HTMLElement;
  const profNote = pop.querySelector('[data-role="profile-note"]') as HTMLElement;

  resSel.value = current.resolution;
  profSel.value = current.profile;
  lightBox.checked = current.lightFill;
  shapeBox.checked = current.shapes;
  resSel.disabled = !opts.resolutionApplicable;

  const refresh = (): void => {
    profNote.textContent = BLOCK_PROFILES.find(p => p.id === profSel.value)?.description ?? '';
    if (!opts.resolutionApplicable) {
      preview.textContent = 'The uploaded model is already a block grid — its resolution is fixed.';
      return;
    }
    const span = opts.getSpan?.() ?? null;
    if (!span) { preview.textContent = 'Load a model to preview the output size.'; return; }
    preview.textContent = describePlan(planResolution(span, resSel.value as ResolutionChoice));
  };

  const commit = (): void => {
    save({
      resolution: resSel.value as ResolutionChoice,
      profile: profSel.value,
      lightFill: lightBox.checked,
      vehicleFacing: facingSel.value as SchemExportSettings['vehicleFacing'],
      lightCoverage: coverageSel.value as 'sealed' | 'covered',
      lightStyle: styleSel.value as 'profile' | 'lantern' | 'sea_lantern',
      lightSpacing: Number(spacingSel.value),
      shapes: shapeBox.checked,
    });
    refresh();
  };
  resSel.addEventListener('change', commit, sig);
  profSel.addEventListener('change', commit, sig);
  lightBox.addEventListener('change', commit, sig);
  for (const select of [facingSel, coverageSel, styleSel, spacingSel]) select.addEventListener('change', commit, sig);
  shapeBox.addEventListener('change', commit, sig);

  const close = (): void => { pop.classList.remove('is-open'); };
  const open = (): void => {
    // Sync from module state — the other surface's popover may have changed it.
    const s = load();
    resSel.value = s.resolution; profSel.value = s.profile;
    lightBox.checked = s.lightFill; shapeBox.checked = s.shapes; syncLights(s);
    refresh();
    const r = btn.getBoundingClientRect();
    pop.classList.add('is-open');
    const h = pop.offsetHeight, w = pop.offsetWidth;
    const top = r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pop.classList.contains('is-open')) close(); else open();
  }, sig);
  pop.addEventListener('click', (e) => e.stopPropagation(), sig);
  document.addEventListener('click', close, sig);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }, sig);

  if (opts.key) mounts.set(opts.key, { pop, ac });
  refresh();
  return { refresh };
}
