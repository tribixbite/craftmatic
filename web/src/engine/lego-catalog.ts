/**
 * LEGO set catalog — powered by Rebrickable public CSV downloads.
 *
 * No API key required. Downloads and parses these public files:
 *   sets.csv.gz   → ~18k sets with name, year, theme, piece count
 *   themes.csv.gz → ~700 themes with parent hierarchy
 *
 * Source: https://rebrickable.com/downloads/
 * License: CC-BY-SA (see rebrickable.com/api/)
 */

import { inflate } from 'pako';

const CDN = 'https://cdn.rebrickable.com/media/downloads';
const IMG_BASE = 'https://cdn.rebrickable.com/media/sets';

export interface CatalogSet {
  set_num: string;
  name: string;
  year: number;
  theme_id: number;
  num_parts: number;
  img_url: string;
  set_url: string;
}

export interface CatalogTheme {
  id: number;
  name: string;
  parent_id: number | null;
}

// ─── State ───────────────────────────────────────────────────────────────────

let setsCache: CatalogSet[] | null = null;
let themesCache: CatalogTheme[] | null = null;
let loadPromise: Promise<void> | null = null;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Download and parse the Rebrickable CSV dumps.
 * Idempotent — safe to call multiple times; only fetches once per page load.
 */
export async function ensureCatalog(
  onProgress?: (msg: string) => void,
): Promise<void> {
  if (setsCache && themesCache) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    onProgress?.('Downloading set catalog (~1 MB)…');
    const [setsText, themesText] = await Promise.all([
      fetchGzip(`${CDN}/sets.csv.gz`),
      fetchGzip(`${CDN}/themes.csv.gz`),
    ]);
    onProgress?.('Parsing…');
    themesCache = parseThemes(themesText);
    setsCache = parseSets(setsText);
    onProgress?.(`Catalog ready — ${setsCache.length.toLocaleString()} sets`);
  })();

  return loadPromise;
}

export function isLoaded(): boolean {
  return setsCache != null && themesCache != null;
}

export function getThemes(): CatalogTheme[] {
  return themesCache ?? [];
}

/**
 * Search the local catalog (must call ensureCatalog first).
 * All matching is case-insensitive. Words in `query` must all appear
 * in the set name OR the set number.
 */
export function searchCatalog(
  query: string,
  themeId: number | null,
  minYear: number | null,
  maxYear: number | null,
  limit = 24,
): CatalogSet[] {
  if (!setsCache) return [];

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  const matches: CatalogSet[] = [];
  for (const s of setsCache) {
    if (themeId != null && s.theme_id !== themeId) continue;
    if (minYear != null && s.year < minYear) continue;
    if (maxYear != null && s.year > maxYear) continue;
    if (words.length > 0) {
      const hay = `${s.name.toLowerCase()} ${s.set_num.toLowerCase()}`;
      if (!words.every(w => hay.includes(w))) continue;
    }
    matches.push(s);
    if (matches.length >= limit) break;
  }
  return matches;
}

// ─── Fetch + Decompress ──────────────────────────────────────────────────────

async function fetchGzip(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const buf = await resp.arrayBuffer();
  const bytes = inflate(new Uint8Array(buf));
  return new TextDecoder('utf-8').decode(bytes);
}

// ─── CSV Parsing ─────────────────────────────────────────────────────────────

function parseSets(csv: string): CatalogSet[] {
  const rows = parseCSV(csv);
  if (rows.length < 2) return [];

  const h = rows[0].map(s => s.trim().toLowerCase());
  const iNum   = h.indexOf('set_num');
  const iName  = h.indexOf('name');
  const iYear  = h.indexOf('year');
  const iTheme = h.indexOf('theme_id');
  const iParts = h.indexOf('num_parts');
  if (iNum < 0 || iName < 0) return [];

  const out: CatalogSet[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const set_num = r[iNum]?.trim();
    const name    = r[iName]?.trim();
    if (!set_num || !name) continue;
    out.push({
      set_num,
      name,
      year:      parseInt(r[iYear] ?? '0')  || 0,
      theme_id:  parseInt(r[iTheme] ?? '0') || 0,
      num_parts: parseInt(r[iParts] ?? '0') || 0,
      img_url:   `${IMG_BASE}/${encodeURIComponent(set_num)}.jpg`,
      set_url:   `https://rebrickable.com/sets/${encodeURIComponent(set_num)}/`,
    });
  }
  return out;
}

function parseThemes(csv: string): CatalogTheme[] {
  const rows = parseCSV(csv);
  if (rows.length < 2) return [];

  const h = rows[0].map(s => s.trim().toLowerCase());
  const iId     = h.indexOf('id');
  const iName   = h.indexOf('name');
  const iParent = h.indexOf('parent_id');
  if (iId < 0 || iName < 0) return [];

  const out: CatalogTheme[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const id   = parseInt(r[iId] ?? '');
    const name = r[iName]?.trim();
    if (!id || !name) continue;
    const parentRaw = r[iParent]?.trim();
    out.push({
      id,
      name,
      parent_id: parentRaw ? (parseInt(parentRaw) || null) : null,
    });
  }
  return out;
}

/** Parse a CSV string into rows of fields. Handles RFC 4180 quoting. */
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  while (i < text.length) {
    rows.push(readRow());
  }
  return rows;

  function readRow(): string[] {
    const fields: string[] = [];
    while (i < text.length) {
      fields.push(readField());
      if (i < text.length && text[i] === ',') { i++; continue; }
      // End of row
      if (i < text.length && text[i] === '\r') i++;
      if (i < text.length && text[i] === '\n') i++;
      break;
    }
    return fields;
  }

  function readField(): string {
    if (text[i] === '"') {
      // Quoted field
      i++;
      let val = '';
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { val += '"'; i += 2; }
          else { i++; break; }
        } else {
          val += text[i++];
        }
      }
      return val;
    }
    // Unquoted — read until comma or newline
    let start = i;
    while (i < text.length && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') i++;
    return text.slice(start, i);
  }
}
