/**
 * LEGO set catalog — loads from pre-bundled /lego-catalog.json.
 * LDraw OMR availability — loads from pre-bundled /omr-index.json.
 *
 * Both JSON files are generated at build time:
 *   bun scripts/prebuild-lego-catalog.ts
 *   bun scripts/prebuild-omr-index.ts
 */

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

const IMG_BASE = 'https://cdn.rebrickable.com/media/sets';

// ─── State ───────────────────────────────────────────────────────────────────

let setsCache: CatalogSet[] | null = null;
let themesCache: CatalogTheme[] | null = null;
let loadPromise: Promise<void> | null = null;

/** Set of set_nums confirmed in the LDraw OMR */
let omrSetNums: Set<string> | null = null;

/** Returns true if the set is in the LDraw OMR (requires ensureCatalog to have been called). */
export function isInOmr(set_num: string): boolean {
  return omrSetNums?.has(set_num) ?? false;
}

/** Returns true if the OMR index has been loaded (so isInOmr results are trustworthy). */
export function isOmrLoaded(): boolean {
  return omrSetNums !== null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load the bundled catalog JSON. Idempotent — safe to call multiple times.
 */
export async function ensureCatalog(
  onProgress?: (msg: string) => void,
): Promise<void> {
  if (setsCache && themesCache) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    onProgress?.('Loading set catalog…');
    const [catalogResp, omrResp] = await Promise.all([
      fetch('/lego-catalog.json'),
      fetch('/omr-index.json'),
    ]);
    if (!catalogResp.ok) throw new Error(`HTTP ${catalogResp.status} loading lego-catalog.json`);
    // Parse both JSON bodies in parallel so all caches are set atomically
    // (avoids a race where isLoaded() is true but omrSetNums is still null)
    const [data, omrList] = await Promise.all([
      catalogResp.json() as Promise<{
        sets: Array<{ set_num: string; name: string; year: number; theme_id: number; num_parts: number }>;
        themes: CatalogTheme[];
      }>,
      omrResp.ok ? omrResp.json() as Promise<string[]> : Promise.resolve(null as null),
    ]);

    themesCache = data.themes;
    setsCache = data.sets.map(s => ({
      ...s,
      img_url: `${IMG_BASE}/${encodeURIComponent(s.set_num)}.jpg`,
      set_url: `https://rebrickable.com/sets/${encodeURIComponent(s.set_num)}/`,
    }));
    if (omrList) omrSetNums = new Set(omrList);

    onProgress?.(`Catalog ready — ${setsCache.length.toLocaleString()} sets`);
  })();

  // Clear on rejection so subsequent calls can retry
  loadPromise.catch(() => { loadPromise = null; });

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
