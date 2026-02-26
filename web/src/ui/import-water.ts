/**
 * Water feature detection — queries OSM Overpass for nearby waterways and waterbodies.
 * Returns rivers, streams, lakes, ponds within a radius of a point.
 * Used to inform landscape generation (water features, bridges, terrain).
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WaterFeature {
  /** OSM feature type: river, stream, lake, pond, canal, reservoir */
  type: string;
  /** Feature name from OSM name tag (may be empty) */
  name?: string;
  /** Center point lat/lon (for ways/relations, centroid from Overpass `out center`) */
  lat: number;
  lon: number;
  /** Approximate distance from query point in meters */
  distanceMeters: number;
}

// ─── Overpass Client ────────────────────────────────────────────────────────

/** Round-robin Overpass endpoints */
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
let overpassIdx = 0;

/** Haversine distance in meters */
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Query OSM for water features within radius of a point.
 * Returns waterways (rivers, streams, canals) and waterbodies (lakes, ponds).
 * Default radius 500m — enough to detect features affecting landscape.
 */
export async function searchWaterFeatures(
  lat: number,
  lon: number,
  radius = 500,
): Promise<WaterFeature[]> {
  // Query both waterway ways and natural=water polygons
  const query = `[out:json][timeout:10];(
    way["waterway"~"river|stream|canal"](around:${radius},${lat},${lon});
    way["natural"="water"](around:${radius},${lat},${lon});
    relation["natural"="water"](around:${radius},${lat},${lon});
  );out tags center;`;
  const body = `data=${encodeURIComponent(query)}`;

  for (let attempt = 0; attempt <= 2; attempt++) {
    const url = OVERPASS_URLS[overpassIdx++ % OVERPASS_URLS.length];
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10000),
      });
      if (resp.status === 429 || resp.status === 504) {
        if (attempt < 2) { await new Promise(r => setTimeout(r, (attempt + 1) * 2000)); continue; }
        return [];
      }
      if (!resp.ok) return [];

      const data = await resp.json() as {
        elements?: {
          tags?: Record<string, string>;
          center?: { lat: number; lon: number };
          lat?: number;
          lon?: number;
        }[];
      };
      if (!data.elements?.length) return [];

      return data.elements
        .filter(e => e.center || (e.lat && e.lon))
        .map(e => {
          const cLat = e.center?.lat ?? e.lat!;
          const cLon = e.center?.lon ?? e.lon!;
          const tags = e.tags ?? {};
          // Determine water type from OSM tags
          let type = tags['waterway'] ?? tags['water'] ?? 'water';
          if (tags['natural'] === 'water' && !tags['water']) type = 'water';
          return {
            type,
            name: tags['name'] || undefined,
            lat: cLat,
            lon: cLon,
            distanceMeters: haversineM(lat, lon, cLat, cLon),
          };
        })
        .sort((a, b) => a.distanceMeters - b.distanceMeters);
    } catch {
      if (attempt < 2) { await new Promise(r => setTimeout(r, (attempt + 1) * 2000)); continue; }
      return [];
    }
  }
  return [];
}
