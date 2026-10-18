/**
 * Console UI — one page, no framework. Transpiled on request by the server
 * (`/app.js`), so it stays TypeScript with no build step.
 *
 * Three panels: SELECT (index filter / CSV / text / packs → a counted
 * selection), OPERATIONS (the cheat sheet, one card per entry point with its
 * real options and the exact command preview), RUNS (queue, live logs,
 * results table, CSV/JSON export). State arrives over SSE.
 */
import type { ConsoleEvent, CpuSample, IndexFilter, Job, Operation, Run, SelectionItem } from '../types.ts';

type Inventory = {
  operations: Operation[];
  stale: { pattern: string; why: string }[];
  groups: string[];
  index: { generated: string; entries: number; sets: number; srcClasses: { src: string; n: number }[] };
  roots: { craftmatic: string; clego: string; runsDir: string };
  maxConcurrency: number;
  cores: number;
  devServer: string;
};
type SelectionSource = 'index' | 'csv' | 'text' | 'packs' | 'none';
type SelectRequest = { source: SelectionSource; filter?: IndexFilter; raw?: string; items?: SelectionItem[] };
type OptionValues = Record<string, string | number | boolean | undefined>;

// ── state ─────────────────────────────────────────────────────────────────────
let inv: Inventory;
let source: SelectionSource = 'index';
const filter: IndexFilter = { asm: 'any', tier: 'any', primaryOnly: true };
let csvRaw = '';
let textRaw = '';
let packs: SelectionItem[] = [];
const chosenPacks = new Set<string>();
let selectionCount = 0;
let selectionSample: SelectionItem[] = [];
let unresolved: string[] = [];
let opId: string | null = null;
const optionValues = new Map<string, OptionValues>();   // per op
let concurrency = 2;
let confirmText = '';
let opSearch = '';
const runs = new Map<string, Run>();
let openRun: string | null = null;
const logs = new Map<string, string>();                 // `${runId}/${jobId}` → text
const openLogs = new Set<string>();
let cpu: CpuSample = { busy: 0, cores: 0, held: false, at: 0 };

// ── tiny DOM helpers ─────────────────────────────────────────────────────────
type Child = Node | string | null | undefined | false | Child[];
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'checked' || k === 'disabled' || k === 'selected') (el as unknown as Record<string, unknown>)[k] = v;
    else if (k === 'value') (el as HTMLInputElement).value = String(v);
    else el.setAttribute(k, String(v));
  }
  const add = (c: Child): void => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(add); return; }
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  };
  children.forEach(add);
  return el;
}
const $ = (id: string): HTMLElement => document.getElementById(id)!;
/** replaceChildren that tolerates null/false/nested children like `h` does. */
const replace = (el: Element, ...children: Child[]): void => { const box = h('div', {}, ...children); el.replaceChildren(...box.childNodes); };
const debounce = <A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) => {
  let t: number | undefined;
  return (...a: A) => { clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); };
};
const api = async <T,>(path: string, body?: unknown): Promise<T> => {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json() as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  return j;
};
const fmtSecs = (j: Job): string => j.startedAt ? `${(((j.endedAt ?? Date.now()) - j.startedAt) / 1000).toFixed(1)} s` : '';
const stateBadge = (s: string): HTMLElement => h('span', { class: `badge ${s === 'done' ? 'ok' : s === 'failed' ? 'bad' : s === 'running' ? 'run' : s === 'skipped' || s === 'cancelled' ? 'warn' : ''}` }, s);

// ── selection ────────────────────────────────────────────────────────────────
function selectRequest(): SelectRequest {
  switch (source) {
    case 'index': return { source, filter };
    case 'csv': return { source, raw: csvRaw };
    case 'text': return { source, raw: textRaw };
    case 'packs': return { source, items: packs.filter(p => chosenPacks.has(p.pack!)) };
    default: return { source: 'none' };
  }
}

const refreshSelection = debounce(async () => {
  try {
    const r = await api<{ count: number; sample: SelectionItem[]; unresolved: string[] }>('/api/select', selectRequest());
    selectionCount = r.count; selectionSample = r.sample; unresolved = r.unresolved;
  } catch (e) { selectionCount = 0; selectionSample = []; unresolved = [String((e as Error).message)]; }
  renderSelectionResult();
  refreshPreview();
}, 250);

function renderSelect(): void {
  const panel = $('panel-select');
  replace(panel,
    h('h2', {}, 'Selection'),
    h('div', { class: 'tabs' }, ...(['index', 'csv', 'text', 'packs', 'none'] as SelectionSource[]).map(s =>
      h('button', { class: s === source ? 'on' : '', onclick: () => { source = s; if (s === 'packs') void loadPacks(); renderSelect(); refreshSelection(); } },
        { index: 'Model index', csv: 'CSV', text: 'Set list', packs: 'Packs', none: 'No item' }[s]))),
    source === 'index' ? renderIndexFilter() : source === 'csv' ? renderCsv() : source === 'text' ? renderText() : source === 'packs' ? renderPacks() :
      h('div', { class: 'card muted small' }, 'For operations that take no item (pack builders, scoreboard, device, provenance).'),
    h('div', { id: 'sel-result' }),
  );
  renderSelectionResult();
}

function numInput(key: keyof IndexFilter, label: string, placeholder = ''): HTMLElement {
  return h('label', {}, label, h('input', { type: 'number', inputmode: 'numeric', placeholder, value: filter[key] ?? '', oninput: (e: Event) => { const v = (e.target as HTMLInputElement).value; (filter as Record<string, unknown>)[key] = v === '' ? undefined : Number(v); refreshSelection(); } }));
}
function textInput(key: keyof IndexFilter, label: string, placeholder = ''): HTMLElement {
  return h('label', {}, label, h('input', { type: 'text', placeholder, value: filter[key] ?? '', oninput: (e: Event) => { const v = (e.target as HTMLInputElement).value; (filter as Record<string, unknown>)[key] = v || undefined; refreshSelection(); } }));
}

function renderIndexFilter(): HTMLElement {
  const srcSel = new Set(filter.src ?? []);
  return h('div', { class: 'card' },
    h('div', { class: 'small muted' }, `index ${inv.index.generated} · ${inv.index.entries.toLocaleString()} entries over ${inv.index.sets.toLocaleString()} sets`),
    h('div', { class: 'row' }, textInput('sets', 'Set number(s)', '71043 10294 or prefix 7104'), textInput('name', 'Name contains', 'Hogwarts')),
    h('div', { class: 'row' }, textInput('text', 'Free text (set, name, path, src, defects)', 'figures: assembly'), textInput('hasDefect', 'Defect contains', 'figures / big_floating / overlap / fragment')),
    h('div', { class: 'row' }, numInput('yearMin', 'Year ≥'), numInput('yearMax', 'Year ≤'), numInput('partsMin', 'Parts ≥'), numInput('partsMax', 'Parts ≤')),
    h('div', { class: 'row' },
      h('label', {}, 'asm', h('select', { onchange: (e: Event) => { filter.asm = (e.target as HTMLSelectElement).value as IndexFilter['asm']; refreshSelection(); } },
        ...['any', 'verified', 'defective'].map(v => h('option', { value: v, selected: filter.asm === v }, v)))),
      numInput('sevMin', 'sev ≥'), numInput('sevMax', 'sev ≤'),
      h('label', {}, 'tier', h('select', { onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; filter.tier = v === 'any' ? 'any' : Number(v) as 1 | 2; refreshSelection(); } },
        ...['any', '1', '2'].map(v => h('option', { value: v, selected: String(filter.tier) === v }, v)))),
      numInput('limit', 'Limit', 'all'),
    ),
    h('div', { class: 'row' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!filter.primaryOnly, onchange: (e: Event) => { filter.primaryOnly = (e.target as HTMLInputElement).checked; refreshSelection(); } }), 'primary pick only (models[0] — what the app auto-loads)'),
    ),
    h('details', { open: srcSel.size > 0 }, h('summary', {}, `source type ${srcSel.size ? `(${srcSel.size} chosen)` : '(all)'}`),
      h('div', { class: 'srcgrid' }, ...inv.index.srcClasses.map(c => h('label', {},
        h('input', { type: 'checkbox', checked: srcSel.has(c.src), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) srcSel.add(c.src); else srcSel.delete(c.src); filter.src = [...srcSel]; const sum = (e.target as HTMLElement).closest('details')?.querySelector('summary'); if (sum) sum.textContent = `source type ${srcSel.size ? `(${srcSel.size} chosen)` : '(all)'}`; refreshSelection(); } }),
        c.src, h('span', { class: 'muted' }, ` ${c.n.toLocaleString()}`)))),
      h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { class: 'small', onclick: () => { filter.src = []; renderSelect(); refreshSelection(); } }, 'clear'))),
  );
}

function renderCsv(): HTMLElement {
  return h('div', { class: 'card' },
    h('div', { class: 'small muted' }, 'Paste or upload a search result. Recognised columns: set / set_num, path (relative to lego_sets or absolute), pack. A header-less single column works too.'),
    h('input', { type: 'file', accept: '.csv,.txt,text/csv', onchange: async (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) { csvRaw = await f.text(); renderSelect(); refreshSelection(); } } }),
    h('textarea', { placeholder: 'set,name\n71043,Hogwarts Castle\n10294,Titanic', value: csvRaw, oninput: (e: Event) => { csvRaw = (e.target as HTMLTextAreaElement).value; refreshSelection(); } }),
  );
}
function renderText(): HTMLElement {
  return h('div', { class: 'card' },
    h('div', { class: 'small muted' }, 'One set number or model path per line. A set number resolves to its primary pick.'),
    h('textarea', { placeholder: '71043\n10294\nOMR/10001-1.mpd', value: textRaw, oninput: (e: Event) => { textRaw = (e.target as HTMLTextAreaElement).value; refreshSelection(); } }),
  );
}
async function loadPacks(): Promise<void> {
  packs = (await api<{ items: SelectionItem[] }>('/api/packs')).items;
  renderSelect();
}
function renderPacks(): HTMLElement {
  return h('div', { class: 'card' },
    h('div', { class: 'row' }, h('div', { class: 'small muted' }, `${packs.length} .mcaddon under output/ (newest first)`),
      h('button', { class: 'small', onclick: () => void loadPacks() }, 'refresh'),
      h('button', { class: 'small', onclick: () => { packs.forEach(p => chosenPacks.add(p.pack!)); renderSelect(); refreshSelection(); } }, 'all'),
      h('button', { class: 'small', onclick: () => { chosenPacks.clear(); renderSelect(); refreshSelection(); } }, 'none')),
    h('div', { class: 'scroll' }, h('table', {}, h('tbody', {}, ...packs.map(p => h('tr', {},
      h('td', {}, h('input', { type: 'checkbox', checked: chosenPacks.has(p.pack!), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) chosenPacks.add(p.pack!); else chosenPacks.delete(p.pack!); refreshSelection(); } })),
      h('td', { class: 'wrap mono' }, p.label ?? p.pack ?? '')))))),
  );
}

function renderSelectionResult(): void {
  const box = document.getElementById('sel-result');
  if (!box) return;
  replace(box,
    h('div', { class: 'count' }, source === 'none' ? '—' : selectionCount.toLocaleString(), h('small', {}, source === 'none' ? 'no item' : 'selected')),
    unresolved.length ? h('div', { class: 'warnbox' }, `${unresolved.length} row(s) did not resolve: `, h('code', {}, unresolved.slice(0, 5).join(' · '))) : null,
    selectionSample.length ? h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'item'), h('th', {}, 'label'), h('th', {}, 'path'))),
      h('tbody', {}, ...selectionSample.map(i => h('tr', {}, h('td', {}, i.id), h('td', {}, i.label ?? ''), h('td', { class: 'wrap mono small' }, i.indexPath ?? i.model ?? i.pack ?? '')))))) : null,
    selectionCount > selectionSample.length ? h('div', { class: 'small muted' }, `showing the first ${selectionSample.length}`) : null,
  );
}

// ── operations (the cheat sheet) ─────────────────────────────────────────────
function opValues(op: Operation): OptionValues {
  let v = optionValues.get(op.id);
  if (!v) { v = {}; for (const o of op.options) if (o.default !== undefined) v[o.key] = o.default; optionValues.set(op.id, v); }
  return v;
}

function renderOps(): void {
  const panel = $('panel-ops');
  const q = opSearch.toLowerCase();
  const visible = inv.operations.filter(o => !q || `${o.id} ${o.title} ${o.answers} ${o.entry} ${o.group}`.toLowerCase().includes(q));
  replace(panel,
    h('h2', {}, 'Operations'),
    h('input', { type: 'search', placeholder: 'find an operation (silhouette, window, pack, r2 …)', value: opSearch, oninput: (e: Event) => { opSearch = (e.target as HTMLInputElement).value; renderOps(); } }),
    h('div', { class: 'oplist', style: 'margin-top:8px' }, ...inv.groups.map(g => {
      const list = visible.filter(o => o.group === g);
      return list.length ? h('div', { class: 'group' }, h('h4', {}, g), ...list.map(o =>
        h('button', { class: `op ${o.id === opId ? 'on' : ''} ${o.danger ? 'danger-op' : ''}`, onclick: () => { opId = o.id; confirmText = ''; renderOps(); refreshPreview(); } },
          o.title, h('span', { class: 'id' }, o.id), o.danger ? h('span', { class: 'badge bad', style: 'margin-left:6px' }, 'confirm') : null))) : null;
    })),
    opId ? renderOpCard(inv.operations.find(o => o.id === opId)!) : h('div', { class: 'card muted small' }, 'Pick an operation to see its cheat sheet: what it answers, its exact invocation, inputs, evidence and duration.'),
    h('details', { class: 'stale' }, h('summary', {}, `Not wired: ${inv.stale.length} script families judged stale or out of scope`),
      h('ul', {}, ...inv.stale.map(s => h('li', {}, h('code', {}, s.pattern), ' — ', s.why)))),
  );
}

function renderOpCard(op: Operation): HTMLElement {
  const values = opValues(op);
  const inputDesc = { model: `a model file (${(op.accepts ?? []).map(e => '.' + e).join(' ')})`, set: 'a set number', 'index-path': 'a corpus path relative to lego_sets/', pack: 'a built .mcaddon', none: 'nothing — one run' }[op.input];
  return h('div', { class: 'card opcard', id: 'opcard' },
    h('h3', {}, op.title),
    h('div', {}, op.answers),
    h('dl', {},
      h('dt', {}, 'entry'), h('dd', { class: 'mono' }, `${op.runtime} ${op.entry}`, h('span', { class: 'muted' }, `  (from ${op.cwd})`)),
      h('dt', {}, 'input'), h('dd', {}, `${inputDesc} · ${op.batch === 'per-item' ? 'one process per item' : 'one process for the whole selection'}`),
      h('dt', {}, 'evidence'), h('dd', { class: 'mono small' }, [op.evidence.fromJson ? `the "${op.evidence.fromJson}" field it prints` : null, op.evidence.dir ?? null, op.evidence.runDir ? `${inv.roots.runsDir}/<run>/` : null].filter(Boolean).join(' · ') || 'stdout only (kept in the run log)'),
      h('dt', {}, 'duration'), h('dd', {}, op.duration),
      op.needs ? h('dt', {}, 'needs') : null, op.needs ? h('dd', {}, op.needs.join(' · ')) : null,
      op.docs ? h('dt', {}, 'docs') : null, op.docs ? h('dd', { class: 'small' }, op.docs.join(' · ')) : null,
    ),
    op.notes ? h('div', { class: 'small muted' }, op.notes) : null,
    op.danger ? h('div', { class: 'dangerbox' }, h('b', {}, 'Outward / destructive: '), op.danger.why, op.danger.dryRunOption ? ' Dry-run is on by default.' : '') : null,
    op.options.length ? h('div', { class: 'opts' }, ...op.options.map(o => {
      const set = (v: string | boolean): void => { values[o.key] = v === '' ? undefined : v; refreshPreview(); };
      const label = `${o.render === 'env' ? `$${o.flag}` : o.render === 'positional' ? `<${o.key}>` : `--${o.flag}`}${o.required ? ' *' : ''}`;
      if (o.type === 'boolean') return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: values[o.key] === true, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }), h('span', {}, label, h('div', { class: 'help' }, o.help)));
      if (o.type === 'enum' && o.values) return h('label', {}, label, h('select', { onchange: (e: Event) => set((e.target as HTMLSelectElement).value) }, h('option', { value: '', selected: values[o.key] === undefined }, '(unset)'), ...o.values.map(v => h('option', { value: v, selected: String(values[o.key]) === v }, v))), h('div', { class: 'help' }, o.help));
      return h('label', {}, label, h('input', { type: o.type === 'number' ? 'number' : 'text', value: values[o.key] ?? '', placeholder: o.default !== undefined ? String(o.default) : '', oninput: (e: Event) => set((e.target as HTMLInputElement).value) }), h('div', { class: 'help' }, o.help));
    })) : null,
    h('div', { class: 'row' },
      op.batch === 'per-item' ? h('label', {}, `concurrency (ceiling ${inv.maxConcurrency} on ${inv.cores} cores; dispatch pauses above 85 % CPU)`, h('input', { type: 'number', min: 1, max: inv.maxConcurrency, value: concurrency, oninput: (e: Event) => { concurrency = Math.max(1, Math.min(inv.maxConcurrency, Number((e.target as HTMLInputElement).value) || 1)); } })) : null,
      op.danger ? h('label', {}, `type ${op.id} to confirm`, h('input', { type: 'text', value: confirmText, oninput: (e: Event) => { confirmText = (e.target as HTMLInputElement).value; } })) : null,
    ),
    h('div', { id: 'preview' }),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: op.danger ? 'danger' : 'primary', onclick: () => void launch(op) }, op.danger ? `Run ${op.title} (confirm)` : `Run ${op.title}`),
      h('button', { onclick: () => { optionValues.delete(op.id); renderOps(); refreshPreview(); } }, 'reset options'),
    ),
  );
}

const refreshPreview = debounce(async () => {
  const box = document.getElementById('preview');
  if (!box || !opId) return;
  const op = inv.operations.find(o => o.id === opId)!;
  try {
    const r = await api<{ count: number; commands: string[]; problems: string[]; skipped: { id: string; reason: string }[] }>('/api/preview', { opId, selection: selectRequest(), options: opValues(op) });
    replace(box,
      h('div', { class: 'small muted' }, op.input === 'none' ? 'one run' : `${r.count} item(s) selected → ${op.batch === 'per-item' ? `${Math.max(0, r.count - r.skipped.length)} job(s)` : 'one process'}${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`),
      r.problems.length ? h('div', { class: 'warnbox' }, r.problems.join(' · ')) : null,
      r.skipped.length ? h('div', { class: 'small muted' }, `skipped: ${r.skipped.slice(0, 5).map(s => `${s.id} (${s.reason})`).join('; ')}${r.skipped.length > 5 ? ' …' : ''}`) : null,
      h('pre', { class: 'cmd' }, r.commands.join('\n')),
    );
  } catch (e) { box.replaceChildren(h('div', { class: 'warnbox' }, (e as Error).message)); }
}, 200);

async function launch(op: Operation): Promise<void> {
  try {
    const r = await api<{ run: Run }>('/api/runs', { opId: op.id, selection: selectRequest(), options: opValues(op), concurrency, confirm: op.danger ? confirmText.trim() : undefined });
    runs.set(r.run.id, r.run); openRun = r.run.id;
    showPanel('runs'); renderRuns();
  } catch (e) { alert((e as Error).message); }
}

// ── runs ─────────────────────────────────────────────────────────────────────
function renderRuns(): void {
  const panel = $('panel-runs');
  const list = [...runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  replace(panel,
    h('h2', {}, 'Runs'),
    list.length ? null : h('div', { class: 'card muted small' }, 'Nothing has run yet. Runs are persisted under ', h('code', {}, inv.roots.runsDir), ' and reappear here after a restart.'),
    h('div', { class: 'runlist' }, ...list.slice(0, 40).map(r => {
      const op = inv.operations.find(o => o.id === r.opId);
      const done = r.jobs.filter(j => j.state === 'done').length, failed = r.jobs.filter(j => j.state === 'failed').length, closed = r.jobs.filter(j => !['queued', 'running'].includes(j.state)).length;
      return h('div', { class: `card run ${r.id === openRun ? 'on' : ''}`, onclick: () => { openRun = r.id; renderRuns(); } },
        h('div', { class: 'row' }, h('b', {}, op?.title ?? r.opId), stateBadge(r.state), h('span', { class: 'muted small' }, new Date(r.createdAt).toLocaleString()),
          r.state === 'running' || r.state === 'queued' ? h('button', { class: 'small', onclick: (e: Event) => { e.stopPropagation(); void api(`/api/runs/${r.id}/cancel`, {}); } }, 'cancel') : null),
        h('div', { class: 'progress' }, h('i', { style: `width:${r.jobs.length ? closed / r.jobs.length * 100 : 0}%` })),
        h('div', { class: 'small muted' }, `${done} done · ${failed} failed · ${r.jobs.length} jobs · ${r.selection.source}${r.selection.items.length ? ` (${r.selection.items.length} items)` : ''} · concurrency ${r.concurrency}`),
        r.id === openRun ? renderRunDetail(r, op) : null);
    })),
  );
}

function renderRunDetail(r: Run, op: Operation | undefined): HTMLElement {
  const cols = op?.columns ?? [];
  const useRows = r.jobs.some(j => j.rows.length > 1 || (j.rows.length === 1 && !j.result));
  const rowCols = useRows ? [...new Set(r.jobs.flatMap(j => j.rows.flatMap(x => Object.keys(x))))] : cols.map(c => c.key);
  const rowLabels = useRows ? rowCols : cols.map(c => c.label);
  return h('div', { onclick: (e: Event) => e.stopPropagation() },
    h('div', { class: 'row', style: 'margin:8px 0' },
      h('a', { href: `/api/runs/${r.id}/export.csv`, download: '' }, h('button', { class: 'small' }, 'export CSV')),
      h('a', { href: `/api/runs/${r.id}/export.json`, download: '' }, h('button', { class: 'small' }, 'export JSON')),
      h('span', { class: 'small muted mono' }, r.dir)),
    h('details', {}, h('summary', {}, 'filter + options that produced this run (in the export too)'),
      h('pre', { class: 'cmd' }, JSON.stringify({ source: r.selection.source, filter: r.selection.filter ?? null, raw: r.selection.raw ? `${r.selection.raw.slice(0, 300)}${r.selection.raw.length > 300 ? '…' : ''}` : null, options: r.options }, null, 1))),
    rowCols.length ? h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'item'), h('th', {}, 'state'), ...rowLabels.map(l => h('th', {}, l)))),
      h('tbody', {}, ...r.jobs.flatMap(j => {
        const rows = useRows ? (j.rows.length ? j.rows : [null]) : [j.result];
        return rows.map(row => h('tr', {}, h('td', {}, j.item?.id ?? '—'), h('td', {}, stateBadge(j.state)),
          ...rowCols.map(c => h('td', { class: 'wrap' }, fmtCell(row ? (row as Record<string, unknown>)[c] : undefined)))));
      })))) : null,
    h('div', { class: 'jobs' }, ...r.jobs.map(j => renderJob(r, j))),
  );
}

const fmtCell = (v: unknown): string => v === undefined || v === null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString() : String(Math.round(v * 10000) / 10000)) : typeof v === 'object' ? JSON.stringify(v) : String(v);

function renderJob(r: Run, j: Job): HTMLElement {
  const key = `${r.id}/${j.id}`;
  const open = openLogs.has(key);
  return h('div', { class: 'job' },
    h('div', { class: 'head' }, h('span', { class: 'item' }, j.item?.label ?? j.item?.id ?? (j.argv.length ? 'one process' : '—')), stateBadge(j.state),
      h('span', { class: 'muted' }, fmtSecs(j)), j.exitCode !== null ? h('span', { class: 'muted' }, `exit ${j.exitCode}`) : null,
      j.argv.length ? h('button', { class: 'small', onclick: async () => { if (open) openLogs.delete(key); else { openLogs.add(key); if (!logs.has(key)) logs.set(key, await (await fetch(`/api/runs/${r.id}/log/${j.id}`)).text()); } renderRuns(); } }, open ? 'hide log' : 'log') : null),
    j.reason ? h('div', { class: 'small', style: 'color:var(--warn)' }, j.reason) : null,
    j.display ? h('pre', { class: 'cmd' }, `(cd ${j.cwd}) ${j.display}`) : null,
    j.evidence.length ? h('div', { class: 'ev' }, 'evidence: ', ...j.evidence.map(e => h('code', {}, e, ' '))) : null,
    open ? h('pre', { class: 'log', id: `log-${key.replace('/', '-')}` }, logs.get(key) ?? '') : null,
  );
}

// ── events ───────────────────────────────────────────────────────────────────
function connect(): void {
  const es = new EventSource('/api/events');
  es.onmessage = ev => {
    const e = JSON.parse(ev.data) as ConsoleEvent;
    switch (e.type) {
      case 'hello': runs.clear(); for (const r of e.runs) runs.set(r.id, r); cpu = e.cpu; renderRuns(); renderStatus(); break;
      case 'run': runs.set(e.run.id, e.run); renderRuns(); break;
      case 'job': { const r = runs.get(e.runId); if (r) { r.jobs[e.job.id] = e.job; renderRuns(); } break; }
      case 'log': { const key = `${e.runId}/${e.jobId}`; logs.set(key, (logs.get(key) ?? '') + e.text); const pre = document.getElementById(`log-${key.replace('/', '-')}`); if (pre) { pre.textContent = logs.get(key)!; pre.scrollTop = pre.scrollHeight; } break; }
      case 'cpu': cpu = e.cpu; renderStatus(); break;
    }
  };
  es.onerror = () => { $('status').textContent = 'disconnected — retrying'; };
}

function renderStatus(): void {
  const running = [...runs.values()].filter(r => r.state === 'running').length;
  replace($('status'),
    h('span', { class: `meter ${cpu.held ? 'held' : ''}` }, 'cpu ', h('span', { class: 'bar' }, h('i', { style: `width:${Math.round(cpu.busy * 100)}%` })), `${Math.round(cpu.busy * 100)} %`, cpu.held ? h('span', { class: 'badge warn' }, 'dispatch held') : null),
    h('span', {}, `${running} run(s) active`),
    h('span', { class: 'mono' }, `dev server ${inv.devServer} for browser gates`),
  );
}

function showPanel(name: 'select' | 'ops' | 'runs'): void {
  for (const b of $('mobile-nav').querySelectorAll('button')) b.classList.toggle('on', b.dataset['panel'] === name);
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('on', p.id === `panel-${name}`);
}

// ── boot ─────────────────────────────────────────────────────────────────────
(async () => {
  inv = await api<Inventory>('/api/inventory');
  concurrency = Math.min(2, inv.maxConcurrency);
  for (const b of $('mobile-nav').querySelectorAll('button')) b.addEventListener('click', () => showPanel(b.dataset['panel'] as 'select'));
  renderSelect(); renderOps(); renderRuns(); renderStatus();
  refreshSelection();
  connect();
})().catch(e => { $('status').textContent = `failed to load: ${(e as Error).message}`; });
