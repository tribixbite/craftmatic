/**
 * LEGO Set tab — search, select, and voxelize LEGO sets.
 *
 * Set search uses the Rebrickable public CSV downloads (no API key required).
 * 3D models come from LDraw MPD/LDR files downloaded from:
 *   • LDraw OMR: library.ldraw.org/omr  (~1,470 sets)
 *   • BrickLink Studio (export → LDraw)
 *
 * Pipeline: MPD upload → ldraw-parser → ldraw-voxelizer → inline 3D viewer
 */

import { BlockGrid } from '@craft/schem/types.js';
import { parseLDraw } from '@engine/ldraw-parser.js';
import { voxelizeLDraw } from '@engine/ldraw-voxelizer.js';
import {
  ensureCatalog, searchCatalog, getThemes, isLoaded, isInOmr,
  type CatalogSet, type CatalogTheme,
} from '@engine/lego-catalog.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const OMR_BASE = 'https://library.ldraw.org/library/omr';
// Route through local proxy (Vite in dev, CF Pages Function in prod) to avoid CORS
const OMR_FETCH_BASE = '/ldraw-omr';

// ─── State ───────────────────────────────────────────────────────────────────

let rootEl: HTMLElement;
let onResult: ((grid: BlockGrid, label: string) => void) | null = null;
let selectedSet: CatalogSet | null = null;
let searchResults: CatalogSet[] = [];

// ─── Init ────────────────────────────────────────────────────────────────────

export function initLego(
  controls: HTMLElement,
  _viewer: HTMLElement,
  callback: (grid: BlockGrid, label: string) => void,
): void {
  rootEl = controls;
  onResult = callback;
  buildUI();
  // Pre-load catalog in background so search is instant when user types
  ensureCatalog(msg => setStatus(msg, 'info')).catch(err => {
    setStatus(`Catalog load failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  });
}

// ─── UI Construction ─────────────────────────────────────────────────────────

function buildUI(): void {
  rootEl.innerHTML = `
    <!-- Status (shared) -->
    <div class="lego-status" id="lego-status" hidden></div>

    <!-- Primary: Upload LDraw file -->
    <div class="lego-section">
      <div class="lego-label-row">
        <span class="lego-section-label">Upload LDraw File</span>
        <span class="lego-section-sub">from LDraw OMR or BrickLink Studio</span>
      </div>
      <label class="lego-upload-zone" id="lego-upload-zone">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="7" width="20" height="14" rx="2"/>
          <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
          <circle cx="8" cy="4" r="1"/><circle cx="12" cy="4" r="1"/><circle cx="16" cy="4" r="1"/>
        </svg>
        <span class="lego-upload-zone-text">
          Drop <code>.mpd</code> / <code>.ldr</code> here, or click to browse
        </span>
        <input type="file" id="lego-mpd-input" accept=".mpd,.ldr" hidden>
      </label>
      <div class="lego-omr-quick">
        <span class="lego-omr-label">Get files:</span>
        <a href="https://library.ldraw.org/omr/sets/" target="_blank" rel="noopener" class="lego-ext-link">LDraw OMR ↗</a>
        <a href="https://www.bricklink.com/v3/studio/studio.page" target="_blank" rel="noopener" class="lego-ext-link">BrickLink Studio ↗</a>
      </div>
    </div>

    <!-- Divider -->
    <div class="lego-divider"><span>or search for a set</span></div>

    <!-- Search (no API key required — uses public CSV) -->
    <div class="lego-section">
      <div class="lego-search-row">
        <input type="text" id="lego-search" class="lego-input lego-search-input"
          placeholder="Set name or number (e.g. 75192, Falcon, CFC)…">
        <button class="btn btn-primary btn-sm" id="lego-search-btn">Search</button>
      </div>
      <div class="lego-filters">
        <select id="lego-theme" class="lego-select" title="Filter by theme">
          <option value="">All Themes</option>
        </select>
        <input type="number" id="lego-year-min" class="lego-input lego-year-input"
          placeholder="From" min="1950" max="2030" title="From year">
        <input type="number" id="lego-year-max" class="lego-input lego-year-input"
          placeholder="To" min="1950" max="2030" title="To year">
      </div>
    </div>

    <!-- Results -->
    <div class="lego-results" id="lego-results" hidden>
      <div class="lego-results-grid" id="lego-results-grid"></div>
    </div>

    <!-- Selected set detail -->
    <div class="lego-detail" id="lego-detail" hidden>
      <div class="lego-detail-inner" id="lego-detail-inner"></div>
      <div class="lego-omr-links" id="lego-omr-links"></div>
    </div>
  `;

  wireEvents();
}

function wireEvents(): void {
  // ── MPD file upload ────────────────────────────────────────────────────────
  const mpdInput = document.getElementById('lego-mpd-input') as HTMLInputElement;
  const uploadZone = document.getElementById('lego-upload-zone') as HTMLLabelElement;

  mpdInput.addEventListener('change', async () => {
    const file = mpdInput.files?.[0];
    if (!file) return;
    await parseMpdFile(file);
    mpdInput.value = '';
  });

  uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
  uploadZone.addEventListener('drop', async e => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    await parseMpdFile(file);
  });

  // ── Search ─────────────────────────────────────────────────────────────────
  const searchInput = document.getElementById('lego-search') as HTMLInputElement;
  const searchBtn   = document.getElementById('lego-search-btn') as HTMLButtonElement;

  const doSearch = async () => {
    const query    = searchInput.value.trim();
    const themeEl  = document.getElementById('lego-theme')    as HTMLSelectElement;
    const minYrEl  = document.getElementById('lego-year-min') as HTMLInputElement;
    const maxYrEl  = document.getElementById('lego-year-max') as HTMLInputElement;
    const themeId  = themeEl.value  ? parseInt(themeEl.value)  : null;
    const minYear  = minYrEl.value  ? parseInt(minYrEl.value)  : null;
    const maxYear  = maxYrEl.value  ? parseInt(maxYrEl.value)  : null;

    if (!query && themeId == null && minYear == null) {
      setStatus('Enter a set name, number, or choose a theme.', 'error');
      return;
    }

    searchBtn.disabled = true;

    try {
      if (!isLoaded()) {
        setStatus('Loading catalog…', 'info');
        await ensureCatalog(msg => setStatus(msg, 'info'));
      }

      searchResults = searchCatalog(query, themeId, minYear, maxYear);
      // Populate theme dropdown once loaded
      populateThemes(getThemes());

      if (searchResults.length === 0) {
        setStatus('No sets found — try a different query.', 'info');
        hideResults();
      } else {
        setStatus(`${searchResults.length} set${searchResults.length !== 1 ? 's' : ''} found`, 'success');
        renderResults(searchResults);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`Search failed: ${msg}`, 'error');
    } finally {
      searchBtn.disabled = false;
    }
  };

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  // Populate themes once catalog finishes loading in background
  ensureCatalog().then(() => populateThemes(getThemes())).catch(() => {});
}

// ─── Results ─────────────────────────────────────────────────────────────────

function renderResults(sets: CatalogSet[]): void {
  const resultsEl = document.getElementById('lego-results')!;
  const gridEl    = document.getElementById('lego-results-grid')!;
  resultsEl.hidden = false;

  gridEl.innerHTML = sets.map((s, i) => {
    const inOmr = isInOmr(s.set_num);
    return `
    <button class="lego-result-card${inOmr ? ' lego-result-card-omr' : ''}" data-idx="${i}" title="${escAttr(s.name)}">
      <img class="lego-result-img" src="/lego-thumbs/${escAttr(s.set_num)}.jpg"
        data-cdn="${escAttr(s.img_url)}" alt="" loading="lazy" decoding="async"
        onerror="if(!this.dataset.tried){this.dataset.tried='1';this.src=this.dataset.cdn;}else{this.style.display='none';this.nextElementSibling.style.display='flex';}">
      <div class="lego-result-img-placeholder" style="display:none">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="7" width="20" height="14" rx="2"/>
          <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
        </svg>
      </div>
      ${inOmr ? '<div class="lego-omr-badge">3D</div>' : ''}
      <div class="lego-result-info">
        <div class="lego-result-num">${escAttr(s.set_num)}</div>
        <div class="lego-result-name">${escAttr(s.name)}</div>
        <div class="lego-result-meta">${s.year} · ${s.num_parts.toLocaleString()} pcs</div>
      </div>
    </button>
  `;
  }).join('');

  gridEl.querySelectorAll<HTMLButtonElement>('.lego-result-card').forEach(card => {
    card.addEventListener('click', () => selectSet(sets[parseInt(card.dataset['idx']!)]));
  });
}

function hideResults(): void {
  const el = document.getElementById('lego-results');
  if (el) el.hidden = true;
}

// ─── Set Selection ───────────────────────────────────────────────────────────

function selectSet(set: CatalogSet): void {
  selectedSet = set;

  document.querySelectorAll<HTMLElement>('.lego-result-card').forEach(c => {
    const idx = parseInt(c.dataset['idx'] ?? '-1', 10);
    c.classList.toggle('selected', idx >= 0 && searchResults[idx] === set);
  });

  const detailEl = document.getElementById('lego-detail')!;
  const innerEl  = document.getElementById('lego-detail-inner')!;
  const omrEl    = document.getElementById('lego-omr-links')!;
  detailEl.hidden = false;

  const setNumBase = set.set_num.replace(/-\d+$/, '');

  innerEl.innerHTML = `
    <div class="lego-detail-header">
      <img class="lego-detail-img" src="/lego-thumbs/${escAttr(set.set_num)}.jpg"
        data-cdn="${escAttr(set.img_url)}" alt=""
        onerror="if(!this.dataset.tried){this.dataset.tried='1';this.src=this.dataset.cdn;}else{this.style.display='none';}">
      <div class="lego-detail-meta">
        <div class="lego-detail-num">${escAttr(set.set_num)}</div>
        <div class="lego-detail-name">${escAttr(set.name)}</div>
        <div class="lego-detail-stats">
          <span>${set.year}</span>
          <span>${set.num_parts.toLocaleString()} pcs</span>
        </div>
        <a href="${escAttr(set.set_url)}" target="_blank" rel="noopener" class="lego-ext-link">
          Rebrickable ↗
        </a>
      </div>
    </div>
    <button class="btn btn-primary lego-auto-load-btn" id="lego-auto-load">
      Auto-Load LDraw from OMR
    </button>
  `;

  // Wire auto-load button
  const autoBtn = document.getElementById('lego-auto-load') as HTMLButtonElement;
  autoBtn.addEventListener('click', () => autoLoadFromOMR(set));

  const omrFileUrl = `${OMR_BASE}/${encodeURIComponent(set.set_num)}.mpd`;
  omrEl.innerHTML = `
    <div class="lego-omr-row">
      <span class="lego-omr-label">Get LDraw file for <code>${escAttr(set.set_num)}</code>:</span>
    </div>
    <div class="lego-omr-row">
      <a href="${escAttr(omrFileUrl)}" target="_blank" rel="noopener" class="lego-ext-link">LDraw OMR ↗</a>
      <a href="https://www.bricklink.com/v3/studio/studio.page" target="_blank" rel="noopener" class="lego-ext-link">BrickLink Studio ↗</a>
    </div>
    <p class="lego-omr-note">
      Click Auto-Load to try automatic download · or open in BrickLink Studio and export <code>.ldr</code> → upload above
    </p>
  `;

  detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ─── OMR Auto-Load ───────────────────────────────────────────────────────────

/**
 * Try to auto-fetch an LDraw file from the LDraw OMR.
 * Attempts several filename patterns for the selected set.
 * Falls back with a direct download URL if CORS blocks the request.
 */
async function autoLoadFromOMR(set: CatalogSet): Promise<void> {
  const btn = document.getElementById('lego-auto-load') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  // Fast path: if we know the set is NOT in the OMR, skip fetching
  if (!isInOmr(set.set_num)) {
    setStatus(
      `${set.set_num} is not in the LDraw OMR (~1,470 sets). Try BrickLink Studio → export LDraw → upload above.`,
      'info',
    );
    if (btn) btn.disabled = false;
    return;
  }

  // OMR download URL: https://library.ldraw.org/library/omr/{set_num}.mpd
  const candidates = [
    `${set.set_num}.mpd`,
  ];

  for (const filename of candidates) {
    const url = `${OMR_FETCH_BASE}/${encodeURIComponent(filename)}`;
    setStatus(`Trying LDraw OMR: ${filename}…`, 'info');

    try {
      const resp = await fetch(url);
      if (resp.status === 404) continue; // try next pattern
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const text = await resp.text();
      if (btn) btn.disabled = false;
      const file = new File([text], filename, { type: 'text/plain' });
      await parseMpdFile(file);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isCors = msg.toLowerCase().includes('cors') ||
                     msg.toLowerCase().includes('network') ||
                     msg.toLowerCase().includes('failed to fetch');
      if (isCors) {
        // CORS blocked — show manual download URL and stop trying
        const manualUrl = `${OMR_BASE}/${encodeURIComponent(set.set_num)}.mpd`;
        setStatus(
          `CORS blocked. Download manually from library.ldraw.org then upload above.`,
          'error',
        );
        const omrEl = document.getElementById('lego-omr-links');
        if (omrEl) {
          omrEl.innerHTML = `
            <div class="lego-omr-row">
              <span class="lego-omr-label">Download <code>${escAttr(set.set_num)}</code> LDraw file:</span>
            </div>
            <div class="lego-omr-row">
              <a href="${escAttr(manualUrl)}" target="_blank" rel="noopener" class="lego-ext-link lego-ext-link-highlight">
                LDraw OMR: ${escAttr(set.set_num)}.mpd ↗
              </a>
              <a href="https://www.bricklink.com/v3/studio/studio.page" target="_blank" rel="noopener" class="lego-ext-link">
                BrickLink Studio ↗
              </a>
            </div>
            <p class="lego-omr-note">
              Download the <code>.mpd</code> file, then drag it into the upload zone above.
            </p>
          `;
        }
        if (btn) btn.disabled = false;
        return;
      }
      throw err; // unexpected error
    }
  }

  // All patterns tried — file not found despite being in index (may have sub-models only)
  setStatus(
    `${set.set_num} is in the OMR but no single-model file found. ` +
    `Try the LDraw OMR link below or BrickLink Studio → export LDraw → upload above.`,
    'info',
  );
  if (btn) btn.disabled = false;
}

// ─── Parse + Voxelize ────────────────────────────────────────────────────────

async function parseMpdFile(file: File): Promise<void> {
  if (!onResult) return;
  setStatus(`Parsing ${file.name}…`, 'info');

  try {
    const text   = await file.text();
    const bricks = parseLDraw(text);
    if (bricks.length === 0) throw new Error('No brick placements found in file.');

    const result = voxelizeLDraw(bricks);
    if (result.warning) setStatus(result.warning, 'info');

    const label = selectedSet
      ? `${selectedSet.set_num} ${selectedSet.name}`
      : file.name.replace(/\.[^.]+$/, '');

    setStatus(
      `Built ${label}: ${result.grid.width}×${result.grid.height}×${result.grid.length} — ${result.grid.countNonAir().toLocaleString()} blocks`,
      'success',
    );
    onResult(result.grid, label);
  } catch (err) {
    setStatus(`Parse failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

// ─── Theme Dropdown ──────────────────────────────────────────────────────────

function populateThemes(themes: CatalogTheme[]): void {
  const select = document.getElementById('lego-theme') as HTMLSelectElement | null;
  if (!select || select.options.length > 1) return; // already populated
  const topLevel = themes.filter(t => t.parent_id == null);
  select.innerHTML = `<option value="">All Themes</option>` +
    topLevel.map(t => `<option value="${t.id}">${escAttr(t.name)}</option>`).join('');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setStatus(msg: string, type: 'info' | 'error' | 'success'): void {
  const el = document.getElementById('lego-status');
  if (!el) return;
  el.textContent = msg;
  el.className = `lego-status lego-status-${type}`;
  el.hidden = !msg;
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
