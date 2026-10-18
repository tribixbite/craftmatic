/**
 * Custom minifig builder — a popover on the LEGO tab that assembles ONE
 * minifig NPC from chosen parts (engine/minifig-rig.ts `minifigFromSpec`) and
 * downloads it as a figures-only playable `.mcaddon` through the real add-on
 * builder. The same thing `scripts/_minifig_ref.ts` does from the CLI.
 *
 * The compile runs on the main thread: a single figure is ~12 parts and ~170
 * cuboids (108 ms in the CLI gate), and the browser's part geometry comes from
 * `/ldraw-parts` exactly as the export Worker's does. Field values persist in
 * localStorage so a figure can be tweaked and re-exported.
 */

import { BlockGrid } from '@craft/schem/types.js';
import { LDRAW_COLOR_RGB } from '@engine/ldraw-colors.js';
import { minifigFromSpec, type MinifigSpec } from '@engine/minifig-rig.js';
import { buildPlayableAddon } from '@engine/playable-addon.js';
import { decodeFigureCode, encodeFigureCode, FigureCodeError } from '@engine/minifig-creator.js';
import { minifigCreatorLibrary } from '@engine/minifig-creator.js';
import { modelExportStem } from '@engine/export-name.js';
import { downloadBytes } from '@ui/schem-export.js';

const STORAGE_KEY = 'craftmatic.minifigBuilder';
const STYLE_ID = 'minifig-builder-style';

/** What the form holds; every part is an LDraw id (no `.dat`), every colour an LDraw colour id. */
export interface MinifigFormValues {
  label: string;
  torsoPart: string; torsoColor: number;
  headPart: string; headColor: number;
  hairPart: string; hairColor: number;
  legsColor: number;
  hipsColor: number;
  armsColor: number;
  handsColor: number;
  heldRightPart: string; heldRightColor: number;
  heldLeftPart: string; heldLeftColor: number;
  cape: boolean; capeColor: number; backPart: string;
}

export const DEFAULT_MINIFIG_FORM: MinifigFormValues = {
  label: 'Custom Minifig',
  torsoPart: '973', torsoColor: 4,
  headPart: '3626c', headColor: 14,
  hairPart: '', hairColor: 0,
  legsColor: 1, hipsColor: 1, armsColor: 4, handsColor: 14,
  heldRightPart: '', heldRightColor: 71,
  heldLeftPart: '', heldLeftColor: 71,
  cape: false, capeColor: 4, backPart: '4524',
};

/** Part suggestions offered beside the free-text part fields (id → what it is). */
export const MINIFIG_PART_SUGGESTIONS: Record<'hair' | 'held', ReadonlyArray<{ part: string; label: string }>> = {
  hair: [
    { part: '', label: 'none' },
    { part: '3901', label: '3901 Hair male' },
    { part: '3625', label: '3625 Hair female ponytail' },
    { part: '3624', label: '3624 Police hat' },
    { part: '3833', label: '3833 Construction helmet' },
    { part: '2446', label: '2446 Helmet classic' },
    { part: '3878', label: '3878 Top hat' },
    { part: '3898', label: '3898 Cook hat' },
    { part: '4485', label: '4485 Cap with long visor' },
    { part: '30380', label: '30380 Cap' },
  ],
  held: [
    { part: '', label: 'none' },
    { part: '3847', label: '3847 Sword' },
    { part: '4497', label: '4497 Spear' },
    { part: '3899', label: '3899 Cup' },
    { part: '30162', label: '30162 Binoculars' },
    { part: '4522', label: '4522 Torch' },
    { part: '3837', label: '3837 Shovel' },
    { part: '3836', label: '3836 Pushbroom' },
    { part: '4006', label: '4006 Spanner' },
    { part: '30173', label: '30173 Katana' },
    { part: '3962', label: '3962 Radio' },
    { part: '3846', label: '3846 Shield' },
  ],
};

/** Strip a `.dat` and whitespace from a typed part id; empty stays empty. */
export function cleanPartId(v: string): string {
  return v.trim().replace(/\.dat$/i, '');
}

/** The rig spec for the form: only the parts the user filled in are sent. */
export function specFromForm(f: MinifigFormValues): MinifigSpec {
  const spec: MinifigSpec = {
    torso: { part: cleanPartId(f.torsoPart) || DEFAULT_MINIFIG_FORM.torsoPart, color: f.torsoColor },
    head: { part: cleanPartId(f.headPart) || DEFAULT_MINIFIG_FORM.headPart, color: f.headColor },
    legs: { color: f.legsColor },
    hips: { color: f.hipsColor },
    arms: { color: f.armsColor },
    hands: { color: f.handsColor },
  };
  const hair = cleanPartId(f.hairPart);
  if (hair) spec.hair = { part: hair, color: f.hairColor };
  const right = cleanPartId(f.heldRightPart);
  if (right) spec.heldRight = { part: right, color: f.heldRightColor };
  const left = cleanPartId(f.heldLeftPart);
  if (left) spec.heldLeft = { part: left, color: f.heldLeftColor };
  if (f.cape) spec.cape = { part: cleanPartId(f.backPart) || '4524', color: f.capeColor };
  return spec;
}

/** Encode this browser form as the same portable code shown by the in-game wand. */
export function figureCodeFromForm(f: MinifigFormValues): string {
  return encodeFigureCode({
    family: 'minifig', name: f.label.slice(0, 24), slots: {
      torso: { part: cleanPartId(f.torsoPart) || '973', color: f.torsoColor },
      head: { part: cleanPartId(f.headPart) || '3626c', color: f.headColor },
      hair: { part: cleanPartId(f.hairPart), color: f.hairColor },
      hips: { part: '3815', color: f.hipsColor }, legs: { part: '3816', color: f.legsColor },
      arms: { part: '3818', color: f.armsColor }, hands: { part: '3820', color: f.handsColor },
      held_right: { part: cleanPartId(f.heldRightPart), color: f.heldRightColor },
      held_left: { part: cleanPartId(f.heldLeftPart), color: f.heldLeftColor },
      back: { part: f.cape ? cleanPartId(f.backPart) || '4524' : '', color: f.capeColor },
    },
  });
}

/** Apply a minifig code to this form. Mini-dolls are intentionally rejected until their rig is measured. */
export function formFromFigureCode(code: string): MinifigFormValues {
  const figure = decodeFigureCode(code);
  if (figure.family !== 'minifig') throw new FigureCodeError('Mini-doll codes are not supported yet: their canonical rig positions are unmeasured.');
  const value = (slot: keyof typeof figure.slots) => figure.slots[slot];
  const torso = value('torso'), head = value('head'), hair = value('hair'), hips = value('hips'), legs = value('legs');
  const arms = value('arms'), hands = value('hands'), right = value('held_right'), left = value('held_left'), back = value('back');
  // These form fields choose colours for canonical moulds, not arbitrary
  // shapes. Refuse unsupported shapes rather than silently changing a code.
  for (const [slot, expected] of [['hips', '3815'], ['legs', '3816'], ['arms', '3818'], ['hands', '3820']] as const) {
    const selected = value(slot);
    if (selected && selected.part !== expected) throw new FigureCodeError(`${slot}: this builder supports ${expected}, not ${selected.part}.`);
  }
  return {
    ...DEFAULT_MINIFIG_FORM, label: figure.name,
    ...(torso ? { torsoPart: torso.part, torsoColor: torso.color } : {}),
    ...(head ? { headPart: head.part, headColor: head.color } : {}),
    ...(hair ? { hairPart: hair.part, hairColor: hair.color } : {}),
    ...(hips ? { hipsColor: hips.color } : {}), ...(legs ? { legsColor: legs.color } : {}),
    ...(arms ? { armsColor: arms.color } : {}), ...(hands ? { handsColor: hands.color } : {}),
    ...(right ? { heldRightPart: right.part, heldRightColor: right.color } : {}),
    ...(left ? { heldLeftPart: left.part, heldLeftColor: left.color } : {}),
    ...(back ? { cape: Boolean(back.part), capeColor: back.color, backPart: back.part || '4524' } : {}),
  };
}

/** Validate stored form values field by field; anything odd falls back to the default. */
export function sanitizeForm(raw: unknown): MinifigFormValues {
  const out: MinifigFormValues = { ...DEFAULT_MINIFIG_FORM };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(out) as Array<keyof MinifigFormValues>) {
    const v = r[k];
    const want = typeof out[k];
    if (typeof v !== want) continue;
    if (want === 'number' && !(Number.isInteger(v) && (v as number) >= 0)) continue;
    if (want === 'string' && (v as string).length > 40) continue;
    (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

function loadForm(): MinifigFormValues {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeForm(JSON.parse(raw)) : { ...DEFAULT_MINIFIG_FORM };
  } catch { return { ...DEFAULT_MINIFIG_FORM }; }
}

function saveForm(f: MinifigFormValues): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(f)); } catch { /* private mode */ }
}

const CSS = `
.mf-pop { position: fixed; z-index: 10001; display: none; width: 340px; max-width: calc(100vw - 20px);
  max-height: calc(100vh - 16px); overflow-y: auto; box-sizing: border-box; padding: 10px 12px 12px;
  background: rgba(20, 22, 30, 0.98); color: #e8e8ef; border: 1px solid rgba(255,255,255,0.16); border-radius: 6px;
  font-size: 0.74rem; line-height: 1.35; box-shadow: 0 8px 28px rgba(0,0,0,0.5); }
.mf-pop.is-open { display: block; }
.mf-pop h4 { margin: 0 0 6px; font-size: 0.8rem; }
.mf-row { display: grid; grid-template-columns: 74px 1fr 118px; gap: 4px 6px; align-items: center; margin-bottom: 4px; }
.mf-row label { color: #b9b9c8; }
.mf-row input, .mf-row select { width: 100%; box-sizing: border-box; font-size: 0.72rem; padding: 3px 4px; border-radius: 3px;
  background: rgba(255,255,255,0.06); color: inherit; border: 1px solid rgba(255,255,255,0.18); }
.mf-row input[list] { min-width: 0; }
.mf-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; }
.mf-actions button { font-size: 0.74rem; padding: 4px 10px; border-radius: 4px; cursor: pointer; border: 1px solid rgba(167,139,250,0.5);
  background: rgba(124,58,237,0.22); color: #c4b5fd; font-family: inherit; }
.mf-actions button[disabled] { opacity: 0.5; cursor: wait; }
.mf-note { color: #9a9aad; font-size: 0.68rem; margin: 4px 0 0; }
.mf-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; border: 1px solid rgba(255,255,255,0.3); }
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

let colorNamesPromise: Promise<Record<string, string>> | null = null;
function loadColorNames(): Promise<Record<string, string>> {
  if (!colorNamesPromise) {
    colorNamesPromise = fetch('/ldraw-color-names.json').then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  }
  return colorNamesPromise;
}

export interface MinifigBuilderMountOptions {
  /** Status line sink (the LEGO tab's setStatus). */
  onStatus?: (msg: string, type: 'info' | 'error' | 'success') => void;
}

/** Colour ids offered, in a sensible order: the classic solids first, then the rest of the RGB table. */
function colorChoices(names: Record<string, string>): Array<{ id: number; name: string; rgb: string }> {
  const first = [0, 15, 4, 1, 2, 14, 19, 71, 72, 70, 25, 27, 5, 26, 22, 28, 308, 320, 321, 322, 323, 191, 226, 484, 85, 84, 378, 379];
  const seen = new Set<number>();
  const out: Array<{ id: number; name: string; rgb: string }> = [];
  const push = (id: number): void => {
    const rgb = LDRAW_COLOR_RGB[id];
    if (!rgb || seen.has(id)) return;
    seen.add(id);
    out.push({ id, name: names[String(id)] ?? `Colour ${id}`, rgb });
  };
  for (const id of first) push(id);
  for (const id of Object.keys(LDRAW_COLOR_RGB).map(Number).sort((a, b) => a - b)) push(id);
  return out;
}

/**
 * Mount the "Minifig" button + popover into `host`. Returns a teardown.
 */
export function mountMinifigBuilder(host: HTMLElement, opts: MinifigBuilderMountOptions = {}): () => void {
  ensureStyle();
  const status = opts.onStatus ?? (() => {});
  const ac = new AbortController();
  const sig = { signal: ac.signal };
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mc-set-btn';
  btn.textContent = '🧍 Minifig';
  btn.title = 'Build a custom minifig NPC and download it as a Bedrock add-on';
  const pop = document.createElement('div');
  pop.className = 'mf-pop';

  const colorSelect = (id: string): string => `<select id="${id}" data-color></select>`;
  const partInput = (id: string, list: 'hair' | 'held' | null, placeholder: string): string =>
    `<input id="${id}" type="text" ${list ? `list="mf-${list}-list"` : ''} placeholder="${placeholder}" maxlength="40" spellcheck="false">`;
  pop.innerHTML = `
    <h4>Custom minifig → Bedrock add-on</h4>
    <datalist id="mf-hair-list">${MINIFIG_PART_SUGGESTIONS.hair.map(p => `<option value="${p.part}">${p.label}</option>`).join('')}</datalist>
    <datalist id="mf-held-list">${MINIFIG_PART_SUGGESTIONS.held.map(p => `<option value="${p.part}">${p.label}</option>`).join('')}</datalist>
    <div class="mf-row"><label for="mf-label">Name</label><input id="mf-label" type="text" maxlength="40" style="grid-column: 2 / 4"></div>
    <div class="mf-row"><label for="mf-torso">Torso</label>${partInput('mf-torso', null, '973 or a printed id')}${colorSelect('mf-torso-color')}</div>
    <div class="mf-row"><label for="mf-head">Head</label>${partInput('mf-head', null, '3626c')}${colorSelect('mf-head-color')}</div>
    <div class="mf-row"><label for="mf-hair">Hair / hat</label>${partInput('mf-hair', 'hair', 'none')}${colorSelect('mf-hair-color')}</div>
    <div class="mf-row"><label>Legs</label><span class="mf-note">3816 / 3817 supplied</span>${colorSelect('mf-legs-color')}</div>
    <div class="mf-row"><label>Hips</label><span class="mf-note">3815 supplied</span>${colorSelect('mf-hips-color')}</div>
    <div class="mf-row"><label>Arms</label><span class="mf-note">3818 / 3819 supplied</span>${colorSelect('mf-arms-color')}</div>
    <div class="mf-row"><label>Hands</label><span class="mf-note">3820 supplied</span>${colorSelect('mf-hands-color')}</div>
    <div class="mf-row"><label for="mf-held-right">Right hand</label>${partInput('mf-held-right', 'held', 'none')}${colorSelect('mf-held-right-color')}</div>
    <div class="mf-row"><label for="mf-held-left">Left hand</label>${partInput('mf-held-left', 'held', 'none')}${colorSelect('mf-held-left-color')}</div>
    <div class="mf-row"><label for="mf-cape">Back item</label><label style="display:flex;gap:6px;align-items:center"><input id="mf-cape" type="checkbox" style="width:auto"> Enabled</label>${colorSelect('mf-cape-color')}</div>
    <div class="mf-row"><label for="mf-back-part">Back part</label><input id="mf-back-part" type="text" placeholder="4524 cape / 2524 backpack" style="grid-column:2 / 4"></div>
    <div class="mf-row"><label for="mf-code">Figure code</label><textarea id="mf-code" rows="3" spellcheck="false" style="grid-column:2 / 4;resize:vertical;font:inherit"></textarea></div>
    <div class="mf-actions"><button id="mf-export" type="button">Download figure pack</button><button id="mf-export-creator" type="button">Export creator wand pack</button><span class="mf-note" data-role="result"></span></div>
    <p class="mf-note">One walking, door-opening NPC on the jointed minifig rig; place it with its Brick Wand. Missing parts are supplied in the figure's own colours; a part the library lacks is reported, not silently dropped.</p>
  `;
  host.appendChild(btn);
  document.body.appendChild(pop);

  const q = <T extends HTMLElement>(id: string): T => pop.querySelector<T>(`#${id}`)!;
  const fields = {
    label: q<HTMLInputElement>('mf-label'),
    torsoPart: q<HTMLInputElement>('mf-torso'), torsoColor: q<HTMLSelectElement>('mf-torso-color'),
    headPart: q<HTMLInputElement>('mf-head'), headColor: q<HTMLSelectElement>('mf-head-color'),
    hairPart: q<HTMLInputElement>('mf-hair'), hairColor: q<HTMLSelectElement>('mf-hair-color'),
    legsColor: q<HTMLSelectElement>('mf-legs-color'), hipsColor: q<HTMLSelectElement>('mf-hips-color'),
    armsColor: q<HTMLSelectElement>('mf-arms-color'), handsColor: q<HTMLSelectElement>('mf-hands-color'),
    heldRightPart: q<HTMLInputElement>('mf-held-right'), heldRightColor: q<HTMLSelectElement>('mf-held-right-color'),
    heldLeftPart: q<HTMLInputElement>('mf-held-left'), heldLeftColor: q<HTMLSelectElement>('mf-held-left-color'),
    cape: q<HTMLInputElement>('mf-cape'), capeColor: q<HTMLSelectElement>('mf-cape-color'), backPart: q<HTMLInputElement>('mf-back-part'),
  };
  const result = pop.querySelector<HTMLElement>('[data-role="result"]')!;
  const exportBtn = q<HTMLButtonElement>('mf-export');
  const creatorExportBtn = q<HTMLButtonElement>('mf-export-creator');
  const codeField = q<HTMLTextAreaElement>('mf-code');

  const read = (): MinifigFormValues => ({
    label: fields.label.value.trim() || DEFAULT_MINIFIG_FORM.label,
    torsoPart: fields.torsoPart.value, torsoColor: Number(fields.torsoColor.value),
    headPart: fields.headPart.value, headColor: Number(fields.headColor.value),
    hairPart: fields.hairPart.value, hairColor: Number(fields.hairColor.value),
    legsColor: Number(fields.legsColor.value), hipsColor: Number(fields.hipsColor.value),
    armsColor: Number(fields.armsColor.value), handsColor: Number(fields.handsColor.value),
    heldRightPart: fields.heldRightPart.value, heldRightColor: Number(fields.heldRightColor.value),
    heldLeftPart: fields.heldLeftPart.value, heldLeftColor: Number(fields.heldLeftColor.value),
    cape: fields.cape.checked, capeColor: Number(fields.capeColor.value), backPart: fields.backPart.value,
  });
  const write = (f: MinifigFormValues): void => {
    fields.label.value = f.label;
    fields.torsoPart.value = f.torsoPart; fields.torsoColor.value = String(f.torsoColor);
    fields.headPart.value = f.headPart; fields.headColor.value = String(f.headColor);
    fields.hairPart.value = f.hairPart; fields.hairColor.value = String(f.hairColor);
    fields.legsColor.value = String(f.legsColor); fields.hipsColor.value = String(f.hipsColor);
    fields.armsColor.value = String(f.armsColor); fields.handsColor.value = String(f.handsColor);
    fields.heldRightPart.value = f.heldRightPart; fields.heldRightColor.value = String(f.heldRightColor);
    fields.heldLeftPart.value = f.heldLeftPart; fields.heldLeftColor.value = String(f.heldLeftColor);
    fields.cape.checked = f.cape; fields.capeColor.value = String(f.capeColor);
    fields.backPart.value = f.backPart;
  };

  // Colour selects are filled once the names arrive; a stored value is applied after.
  const fillColors = async (): Promise<void> => {
    const names = await loadColorNames();
    const choices = colorChoices(names);
    for (const sel of pop.querySelectorAll<HTMLSelectElement>('select[data-color]')) {
      sel.innerHTML = choices.map(c => `<option value="${c.id}" style="background:${c.rgb};color:#000">${c.id} · ${c.name}</option>`).join('');
    }
    write(loadForm());
    refreshCode();
  };
  void fillColors();

  const refreshCode = (): void => { try { codeField.value = figureCodeFromForm(read()); } catch { /* incomplete form while typing */ } };
  codeField.addEventListener('change', () => {
    try { write(formFromFigureCode(codeField.value)); saveForm(read()); result.textContent = 'figure code applied'; }
    catch (e) { result.textContent = e instanceof Error ? e.message : String(e); }
  }, sig);

  pop.addEventListener('change', event => { if (event.target !== codeField) { saveForm(read()); refreshCode(); } }, sig);
  pop.addEventListener('input', event => { if (event.target !== codeField) { saveForm(read()); refreshCode(); } }, sig);

  let creatorExportRequested = false;
  const exportPack = async (): Promise<void> => {
    const f = read();
    saveForm(f);
    const spec = specFromForm(f);
    exportBtn.disabled = true; creatorExportBtn.disabled = true;
    result.textContent = 'compiling…';
    status(`Building minifig "${f.label}"…`, 'info');
    try {
      const figure = minifigFromSpec(spec);
      const stem = modelExportStem({ name: f.label });
      const t0 = performance.now();
      const pack = await buildPlayableAddon(new BlockGrid(3, 1, 3), {
        stem, label: f.label,
        figures: [{ bricks: figure.bricks, x: 1.5, y: 0, z: 1.5, facingLdu: [0, -1] }],
        ...(creatorExportRequested ? { minifigCreator: minifigCreatorLibrary('starter') } : {}),
        onProgress: phase => { result.textContent = phase; },
      });
      downloadBytes(pack.bytes, `${stem}.mcaddon`);
      const ms = Math.round(performance.now() - t0);
      const warn = pack.warnings.filter(w => !/front\/rear direction/.test(w));
      result.textContent = `${(pack.bytes.length / 1024).toFixed(0)} KB · ${ms} ms${warn.length ? ` · ${warn.length} note${warn.length === 1 ? '' : 's'}` : ''}`;
      status(`${creatorExportRequested ? 'Creator wand pack' : 'Minifig'} "${f.label}" exported (${figure.bricks.length} parts${figure.synthesized.length ? `, supplied: ${figure.synthesized.join(', ')}` : ''}). Import the .mcaddon, then ${pack.functionCommand} gives its Brick Wand.${warn.length ? ` Notes: ${warn.join(' ')}` : ''}`, warn.length ? 'info' : 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.textContent = 'failed';
      status(`Minifig export failed: ${msg}`, 'error');
    } finally {
      exportBtn.disabled = false; creatorExportBtn.disabled = false; creatorExportRequested = false;
    }
  };
  exportBtn.addEventListener('click', () => { void exportPack(); }, sig);
  creatorExportBtn.addEventListener('click', () => { creatorExportRequested = true; void exportPack(); }, sig);

  const close = (): void => { pop.classList.remove('is-open'); };
  const open = (): void => {
    pop.classList.add('is-open');
    const r = btn.getBoundingClientRect();
    const h = pop.offsetHeight, w = pop.offsetWidth;
    const top = r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
  };
  btn.addEventListener('click', e => { e.stopPropagation(); if (pop.classList.contains('is-open')) close(); else open(); }, sig);
  pop.addEventListener('click', e => e.stopPropagation(), sig);
  document.addEventListener('click', close, sig);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); }, sig);

  return () => { ac.abort(); btn.remove(); pop.remove(); };
}
