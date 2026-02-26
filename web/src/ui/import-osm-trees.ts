/**
 * OSM Overpass tree query — fetches individual trees near a lat/lng point.
 * Returns species, height, leaf type when available in OSM tags.
 * Uses the same round-robin retry strategy as the building query.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OSMTreeData {
  lat: number;
  lon: number;
  /** Common species name or genus (e.g. "Quercus", "Acer") */
  species?: string;
  /** Height in meters if tagged */
  height?: number;
  /** Leaf type: "broadleaved" or "needleleaved" */
  leafType?: string;
  /** Leaf cycle: "deciduous" or "evergreen" */
  leafCycle?: string;
}

interface OverpassNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

// ─── Overpass Client ────────────────────────────────────────────────────────

/** Round-robin Overpass endpoints to avoid rate limits during parallel queries */
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
let overpassIdx = 0;

/**
 * Search OSM for individual trees within a radius of a point.
 * Queries `natural=tree` nodes. Typical radius: 100–200m around the building.
 *
 * @returns Array of tree positions with optional metadata, never throws
 */
export async function searchOSMTrees(
  lat: number,
  lng: number,
  radius = 150,
): Promise<OSMTreeData[]> {
  // Also fetch tree_rows (ways) for avenue/hedgerow trees
  const query = `[out:json][timeout:10];node["natural"="tree"](around:${radius},${lat},${lng});out body;`;
  const body = `data=${encodeURIComponent(query)}`;

  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const url = OVERPASS_URLS[overpassIdx++ % OVERPASS_URLS.length];
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10000),
      });

      if (resp.status === 429 || resp.status === 504) {
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
          continue;
        }
        return [];
      }

      if (!resp.ok) return [];

      const data = await resp.json() as { elements?: OverpassNode[] };
      if (!data.elements?.length) return [];

      return data.elements
        .filter((e): e is OverpassNode => e.type === 'node')
        .map(node => {
          const t = node.tags ?? {};
          // Parse height: "12", "12 m", "12m" → 12
          let height: number | undefined;
          if (t['height']) {
            const h = parseFloat(t['height']);
            if (!isNaN(h) && h > 0 && h < 100) height = h;
          }
          return {
            lat: node.lat,
            lon: node.lon,
            species: t['species'] || t['genus'] || t['taxon'] || undefined,
            height,
            leafType: t['leaf_type'] as OSMTreeData['leafType'],
            leafCycle: t['leaf_cycle'] as OSMTreeData['leafCycle'],
          };
        });
    } catch {
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
      return [];
    }
  }
  return [];
}
