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
 * Rank catalog sets against a query. Pure (exported for tests).
 *
 * All matching is case-insensitive; every query word must appear in the set
 * name OR set number. Matches are RANKED, not returned in file order — the
 * old first-N-in-file-order behaviour meant a query like "castle" (200
 * matches) surfaced 1970s promo sets and buried the flagships (21063
 * Neuschwanstein, 71043 Hogwarts) past the result cap.
 *
 * Score: exact set-number match dominates; then name-match quality (exact >
 * prefix > word-boundary hits); then a flagship boost (part count, capped)
 * and mild recency so big modern sets beat tiny vintage ones at equal
 * text relevance.
 */
export function rankSets(
  sets: CatalogSet[],
  query: string,
  themeId: number | null,
  minYear: number | null,
  maxYear: number | null,
  limit = 24,
): CatalogSet[] {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);

  const scored: { s: CatalogSet; score: number }[] = [];
  for (const s of sets) {
    if (themeId != null && s.theme_id !== themeId) continue;
    if (minYear != null && s.year < minYear) continue;
    if (maxYear != null && s.year > maxYear) continue;

    const name = s.name.toLowerCase();
    const num = s.set_num.toLowerCase();
    if (words.length > 0) {
      const hay = `${name} ${num}`;
      if (!words.every(w => hay.includes(w))) continue;
    }

    let score = 0;
    if (q && (num === q || num.startsWith(`${q}-`))) score += 1000; // exact set number
    if (q && name === q) score += 400;
    // NOTE: keep the prefix bonus SMALL — "+120 for startsWith" let generic
    // prefixed names ("Castle Mini Figures") outrank flagships ("Hogwarts
    // Castle"), which is the exact bug this ranking exists to fix.
    if (q && name.startsWith(q)) score += 30;
    for (const w of words) {
      // word-boundary hit in the name beats a mere substring
      if (name === w || name.startsWith(`${w} `) || name.includes(` ${w}`)) score += 40;
    }
    score += Math.min(60, (s.num_parts ?? 0) / 100); // flagship boost (6000 parts = +60)
    score += Math.max(0, Math.min(15, (s.year - 1995) * 0.5)); // mild recency
    scored.push({ s, score });
  }

  scored.sort((a, b) => b.score - a.score || (b.s.num_parts ?? 0) - (a.s.num_parts ?? 0));
  return scored.slice(0, limit).map(e => e.s);
}

/**
 * Search the local catalog (must call ensureCatalog first).
 * Relevance-ranked — see rankSets.
 */
export function searchCatalog(
  query: string,
  themeId: number | null,
  minYear: number | null,
  maxYear: number | null,
  limit = 24,
): CatalogSet[] {
  if (!setsCache) return [];
  return rankSets(setsCache, query, themeId, minYear, maxYear, limit);
}
