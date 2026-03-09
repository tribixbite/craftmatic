/**
 * LEGO Set tab — search, select, and voxelize LEGO sets.
 *
 * Data sources:
 *   • Rebrickable API (rebrickable.com/api/v3) — set search & metadata
 *     Requires a free API key: rebrickable.com/users/create/ → Settings → API Key
 *   • LDraw MPD files (.mpd/.ldr) — 3D brick placement data
 *     Download from: library.ldraw.org/omr  or  BrickLink Studio
 *
 * 3D pipeline:
 *   MPD file → ldraw-parser (extract brick positions) →
 *   ldraw-voxelizer (snap LDU coords → BlockGrid) → inline viewer
 */

import { BlockGrid } from '@craft/schem/types.js';
import { parseLDraw } from '@engine/ldraw-parser.js';
import { voxelizeLDraw } from '@engine/ldraw-voxelizer.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface RebrickableSet {
  set_num: string;
  name: string;
  year: number;
  theme_id: number;
  num_parts: number;
  set_img_url: string | null;
  set_url: string;
}

interface RebrickableTheme {
  id: number;
  parent_id: number | null;
  name: string;
}

interface SearchResponse {
  count: number;
  next: string | null;
  results: RebrickableSet[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const API_BASE = 'https://rebrickable.com/api/v3/lego';
const KEY_STORAGE = 'craftmatic_rebrickable_key';
const OMR_BASE = 'https://library.ldraw.org/omr/sets';

/** Well-known themes for the filter (id → name from Rebrickable) */
const POPULAR_THEMES: { id: number; name: string }[] = [
  { id: 171, name: 'Star Wars' },
  { id: 1,   name: 'Technic' },
  { id: 52,  name: 'City' },
  { id: 22,  name: 'Creator' },
  { id: 155, name: 'Ninjago' },
  { id: 246, name: 'Harry Potter' },
  { id: 166, name: 'Marvel Super Heroes' },
  { id: 216, name: 'Minecraft' },
  { id: 306, name: 'Ideas' },
  { id: 392, name: 'Speed Champions' },
  { id: 274, name: 'Architecture' },
  { id: 435, name: 'Botanical' },
  { id: 116, name: 'Mindstorms' },
  { id: 5,   name: 'Bionicle' },
  { id: 9,   name: 'Castle' },
  { id: 17,  name: 'Space' },
  { id: 21,  name: 'Pirates' },
];

// ─── State ───────────────────────────────────────────────────────────────────

let rootEl: HTMLElement;
let onResult: ((grid: BlockGrid, label: string) => void) | null = null;
let selectedSet: RebrickableSet | null = null;
let searchResults: RebrickableSet[] = [];

// ─── API Key ─────────────────────────────────────────────────────────────────

function getKey(): string { return localStorage.getItem(KEY_STORAGE) ?? ''; }
function setKey(k: string): void {
  if (k.trim()) localStorage.setItem(KEY_STORAGE, k.trim());
  else localStorage.removeItem(KEY_STORAGE);
}
function hasKey(): boolean { return getKey().length > 0; }

// ─── Rebrickable API ─────────────────────────────────────────────────────────

async function searchSets(
  query: string,
  themeId: number | null,
  minYear: number | null,
  maxYear: number | null,
): Promise<RebrickableSet[]> {
  const key = getKey();
  const params = new URLSearchParams({ page_size: '24', ordering: '-year' });
  if (query.trim()) params.set('search', query.trim());
  if (themeId != null) params.set('theme_id', String(themeId));
  if (minYear != null) params.set('min_year', String(minYear));
  if (maxYear != null) params.set('max_year', String(maxYear));

  const resp = await fetch(`${API_BASE}/sets/?${params}`, {
    headers: { Authorization: `key ${key}` },
  });
  if (!resp.ok) throw new Error(`Rebrickable API ${resp.status}: ${resp.statusText}`);
  const data: SearchResponse = await resp.json();
  return data.results;
}

async function loadThemes(): Promise<RebrickableTheme[]> {
  const key = getKey();
  const resp = await fetch(`${API_BASE}/themes/?page_size=200`, {
    headers: { Authorization: `key ${key}` },
  });
  if (!resp.ok) return POPULAR_THEMES.map(t => ({ ...t, parent_id: null }));
  const data = await resp.json();
  return (data.results ?? []) as RebrickableTheme[];
}

// ─── MPD Parsing Pipeline ────────────────────────────────────────────────────

async function buildFromMpd(file: File): Promise<{ grid: BlockGrid; label: string }> {
  const text = await file.text();
  const bricks = parseLDraw(text);
  if (bricks.length === 0) throw new Error('No brick placements found in MPD/LDR file.');
  const result = voxelizeLDraw(bricks);
  const label = selectedSet ? `${selectedSet.set_num} ${selectedSet.name}` : file.name.replace(/\.[^.]+$/, '');
  if (result.warning) console.warn('[LEGO]', result.warning);
  return { grid: result.grid, label };
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function initLego(
  controls: HTMLElement,
  _viewer: HTMLElement,
  callback: (grid: BlockGrid, label: string) => void,
): void {
  rootEl = controls;
  onResult = callback;
  buildUI();
}

// ─── UI Construction ─────────────────────────────────────────────────────────

function buildUI(): void {
  const key = getKey();
  const maskedKey = key ? `••••${key.slice(-4)}` : '';

  rootEl.innerHTML = `
    <!-- API Key Section -->
    <div class="lego-section">
      <div class="lego-key-row">
        <label class="lego-label">
          Rebrickable API Key
          <span class="lego-key-status" id="lego-key-status">
            ${key ? `Stored: ${maskedKey}` : 'Required for set search'}
          </span>
        </label>
        <div class="lego-key-input-row">
          <input type="password" id="lego-key-input" class="lego-input"
            placeholder="${key ? 'Update key...' : 'Paste Rebrickable API key'}">
          <button class="btn btn-secondary btn-sm" id="lego-key-save">Save</button>
          <a href="https://rebrickable.com/users/create/" target="_blank"
            rel="noopener" class="lego-ext-link" title="Create free account to get API key">Get key</a>
        </div>
      </div>
    </div>

    <!-- Search Section -->
    <div class="lego-section">
      <div class="lego-search-row">
        <input type="text" id="lego-search" class="lego-input lego-search-input"
          placeholder="Set name or number (e.g. 75192, Millennium Falcon)...">
        <button class="btn btn-primary btn-sm" id="lego-search-btn"
          ${!key ? 'disabled title="Save an API key first"' : ''}>Search</button>
      </div>
      <div class="lego-filters">
        <select id="lego-theme" class="lego-select" title="Filter by theme">
          <option value="">All Themes</option>
          ${POPULAR_THEMES.map(t => `<option value="${t.id}">${escAttr(t.name)}</option>`).join('\n          ')}
        </select>
        <input type="number" id="lego-year-min" class="lego-input lego-year-input"
          placeholder="From year" min="1950" max="2030">
        <input type="number" id="lego-year-max" class="lego-input lego-year-input"
          placeholder="To year" min="1950" max="2030">
      </div>
      <div class="lego-status" id="lego-status"></div>
    </div>

    <!-- Results -->
    <div class="lego-results" id="lego-results" hidden>
      <div class="lego-results-grid" id="lego-results-grid"></div>
    </div>

    <!-- Selected Set Detail -->
    <div class="lego-detail" id="lego-detail" hidden>
      <div class="lego-detail-inner" id="lego-detail-inner"></div>
      <div class="lego-build-section">
        <button class="btn btn-primary btn-full" id="lego-build-btn">
          Build 3D Replica
        </button>
        <div class="lego-mpd-hint" id="lego-mpd-hint">
          Upload an LDraw <code>.mpd</code> or <code>.ldr</code> file for this set:
        </div>
        <label class="lego-upload-label" id="lego-upload-label">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Upload MPD / LDR file
          <input type="file" id="lego-mpd-input" accept=".mpd,.ldr,.io" hidden>
        </label>
        <div class="lego-omr-links" id="lego-omr-links"></div>
      </div>
    </div>
  `;

  wireEvents();
}

function wireEvents(): void {
  // ── API Key ────────────────────────────────────────────────────────────────
  const keyInput = document.getElementById('lego-key-input') as HTMLInputElement;
  const keySave = document.getElementById('lego-key-save')!;
  keySave.addEventListener('click', () => {
    const val = keyInput.value.trim();
    if (!val) return;
    setKey(val);
    keyInput.value = '';
    const statusEl = document.getElementById('lego-key-status')!;
    statusEl.textContent = `Stored: ••••${val.slice(-4)}`;
    keySave.textContent = 'Saved';
    setTimeout(() => { keySave.textContent = 'Save'; }, 1500);
    // Enable search button
    const searchBtn = document.getElementById('lego-search-btn') as HTMLButtonElement;
    searchBtn.disabled = false;
    searchBtn.title = '';
    // Try loading full theme list
    loadThemes().then(themes => {
      populateThemes(themes);
    }).catch(() => { /* fall back to static list */ });
  });

  // ── Search ─────────────────────────────────────────────────────────────────
  const searchInput = document.getElementById('lego-search') as HTMLInputElement;
  const searchBtn = document.getElementById('lego-search-btn')!;

  const doSearch = async () => {
    if (!hasKey()) { setStatus('Save a Rebrickable API key first.', 'error'); return; }
    const query = searchInput.value.trim();
    const themeEl = document.getElementById('lego-theme') as HTMLSelectElement;
    const minYearEl = document.getElementById('lego-year-min') as HTMLInputElement;
    const maxYearEl = document.getElementById('lego-year-max') as HTMLInputElement;
    const themeId = themeEl.value ? parseInt(themeEl.value) : null;
    const minYear = minYearEl.value ? parseInt(minYearEl.value) : null;
    const maxYear = maxYearEl.value ? parseInt(maxYearEl.value) : null;

    if (!query && themeId == null && minYear == null) {
      setStatus('Enter a set name, number, or choose a theme.', 'error');
      return;
    }

    setStatus('Searching...', 'info');
    searchBtn.setAttribute('disabled', '');
    try {
      searchResults = await searchSets(query, themeId, minYear, maxYear);
      if (searchResults.length === 0) {
        setStatus('No sets found. Try a different search.', 'info');
        hideResults();
      } else {
        setStatus(`${searchResults.length} set${searchResults.length !== 1 ? 's' : ''} found`, 'success');
        renderResults(searchResults);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS')) {
        setStatus('Network error — Rebrickable API may not be reachable from browser. Try the direct set number path below.', 'error');
      } else {
        setStatus(`Search failed: ${msg}`, 'error');
      }
    } finally {
      searchBtn.removeAttribute('disabled');
    }
  };

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  // ── MPD Upload ─────────────────────────────────────────────────────────────
  const mpdInput = document.getElementById('lego-mpd-input') as HTMLInputElement;
  mpdInput.addEventListener('change', async () => {
    const file = mpdInput.files?.[0];
    if (!file) return;
    await parseMpdFile(file);
    mpdInput.value = '';
  });

  // ── Build button (also triggers upload) ───────────────────────────────────
  document.getElementById('lego-build-btn')!.addEventListener('click', () => {
    // Build button opens the upload picker as primary action
    document.getElementById('lego-mpd-input')!.click();
  });

  // Load themes if key already exists
  if (hasKey()) {
    loadThemes().then(themes => {
      allThemes = themes;
      populateThemes(themes);
    }).catch(() => {});
  }
}

// ─── Results Rendering ───────────────────────────────────────────────────────

function renderResults(sets: RebrickableSet[]): void {
  const resultsEl = document.getElementById('lego-results')!;
  const gridEl = document.getElementById('lego-results-grid')!;
  resultsEl.hidden = false;

  gridEl.innerHTML = sets.map((s, i) => `
    <button class="lego-result-card" data-idx="${i}" title="${escAttr(s.name)}">
      ${s.set_img_url
        ? `<img class="lego-result-img" src="${escAttr(s.set_img_url)}" alt="" loading="lazy" decoding="async">`
        : `<div class="lego-result-img-placeholder">
            <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="2" y="7" width="20" height="14" rx="2"/>
              <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
              <circle cx="12" cy="14" r="2"/>
            </svg>
          </div>`
      }
      <div class="lego-result-info">
        <div class="lego-result-num">${escAttr(s.set_num)}</div>
        <div class="lego-result-name">${escAttr(s.name)}</div>
        <div class="lego-result-meta">${s.year} · ${s.num_parts.toLocaleString()} pcs</div>
      </div>
    </button>
  `).join('');

  gridEl.querySelectorAll<HTMLButtonElement>('.lego-result-card').forEach(card => {
    card.addEventListener('click', () => {
      const idx = parseInt(card.dataset['idx']!);
      selectSet(sets[idx]);
    });
  });
}

function hideResults(): void {
  const el = document.getElementById('lego-results');
  if (el) el.hidden = true;
}

// ─── Set Selection ───────────────────────────────────────────────────────────

function selectSet(set: RebrickableSet): void {
  selectedSet = set;

  // Highlight selected card
  document.querySelectorAll<HTMLElement>('.lego-result-card').forEach(c => {
    const idx = parseInt(c.dataset['idx'] ?? '-1', 10);
    c.classList.toggle('selected', idx >= 0 && searchResults[idx] === set);
  });

  const detailEl = document.getElementById('lego-detail')!;
  const innerEl = document.getElementById('lego-detail-inner')!;
  detailEl.hidden = false;

  // Set number for OMR — strip variant suffix (e.g. "75192-1" → "75192")
  const setNumBase = set.set_num.replace(/-\d+$/, '');

  innerEl.innerHTML = `
    <div class="lego-detail-header">
      ${set.set_img_url
        ? `<img class="lego-detail-img" src="${escAttr(set.set_img_url)}" alt="">`
        : ''
      }
      <div class="lego-detail-meta">
        <div class="lego-detail-num">${escAttr(set.set_num)}</div>
        <div class="lego-detail-name">${escAttr(set.name)}</div>
        <div class="lego-detail-stats">
          <span>${set.year}</span>
          <span>${set.num_parts.toLocaleString()} pieces</span>
        </div>
        <a href="${escAttr(set.set_url)}" target="_blank" rel="noopener" class="lego-ext-link">
          View on Rebrickable ↗
        </a>
      </div>
    </div>
  `;

  // OMR links
  const omrLinks = document.getElementById('lego-omr-links')!;
  omrLinks.innerHTML = `
    <div class="lego-omr-row">
      <span class="lego-omr-label">Download LDraw file from:</span>
      <a href="${OMR_BASE}/${setNumBase}/" target="_blank" rel="noopener" class="lego-ext-link">
        LDraw OMR ↗
      </a>
      <a href="https://www.bricklink.com/v3/studio/studio.page" target="_blank"
        rel="noopener" class="lego-ext-link">BrickLink Studio ↗</a>
    </div>
    <p class="lego-omr-note">
      ~1,470 sets available at LDraw OMR · Export to <code>.ldr</code> from BrickLink Studio
    </p>
  `;

  // Show hint
  document.getElementById('lego-mpd-hint')!.hidden = false;
  document.getElementById('lego-upload-label')!.hidden = false;

  // Scroll detail into view
  detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ─── MPD Parse + Voxelize ────────────────────────────────────────────────────

async function parseMpdFile(file: File): Promise<void> {
  if (!onResult) return;
  setStatus(`Parsing ${file.name}...`, 'info');

  try {
    const { grid, label } = await buildFromMpd(file);
    setStatus(`Built: ${grid.width}×${grid.height}×${grid.length} — ${grid.countNonAir().toLocaleString()} blocks`, 'success');
    onResult(grid, label);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(`Parse failed: ${msg}`, 'error');
  }
}

// ─── Theme Selector ───────────────────────────────────────────────────────────

function populateThemes(themes: RebrickableTheme[]): void {
  const select = document.getElementById('lego-theme') as HTMLSelectElement | null;
  if (!select) return;
  // Use loaded themes (top-level only) or fall back to popular list
  const topLevel = themes.filter(t => t.parent_id == null);
  const list = topLevel.length > 0 ? topLevel : POPULAR_THEMES.map(t => ({ ...t, parent_id: null }));
  select.innerHTML = `<option value="">All Themes</option>` +
    list.map(t => `<option value="${t.id}">${escAttr(t.name)}</option>`).join('');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(msg: string, type: 'info' | 'error' | 'success'): void {
  const el = document.getElementById('lego-status');
  if (!el) return;
  el.textContent = msg;
  el.className = `lego-status lego-status-${type}`;
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
