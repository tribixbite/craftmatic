/**
 * Mapbox Tilequery building height client — browser-compatible.
 *
 * Queries Mapbox vector tiles for building height (LiDAR/3DEP derived).
 * Uses the same endpoint as the CLI (src/gen/api/mapbox.ts) but takes
 * the Mapbox token from localStorage instead of process.env.
 *
 * This was the critical missing piece: the import page had a Mapbox token
 * field but only used it for satellite tile imagery, never for building
 * height queries — meaning story count never benefited from Mapbox data.
 */

import { getMapboxToken, hasMapboxToken } from './import-mapbox.js';

const API_BASE = 'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery';

export interface MapboxBuildingResult {
  height: number;
  minHeight: number;
  buildingType?: string;
  extrude: boolean;
  distance: number;
}

/**
 * Query Mapbox Tilequery for building height near a lat/lng point.
 * Returns the closest building with height data, or null.
 */
export async function queryMapboxBuildingHeight(
  lat: number,
  lng: number,
  radiusMeters = 30,
): Promise<MapboxBuildingResult | null> {
  const token = getMapboxToken();
  if (!token) return null;

  const radius = Math.min(radiusMeters, 100);
  const url = `${API_BASE}/${lng},${lat}.json?radius=${radius}&layers=building&limit=10&access_token=${token}`;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;

    const data = await resp.json() as {
      features?: Array<{
        properties?: {
          height?: number;
          min_height?: number;
          type?: string;
          extrude?: string;
          tilequery?: { distance: number };
        };
      }>;
    };

    if (!data.features || !Array.isArray(data.features)) return null;

    const buildings: MapboxBuildingResult[] = [];
    for (const feat of data.features) {
      const props = feat.properties;
      if (!props?.height || props.height <= 0) continue;
      buildings.push({
        height: props.height,
        minHeight: props.min_height ?? 0,
        buildingType: props.type || undefined,
        extrude: props.extrude === 'true',
        distance: props.tilequery?.distance ?? 999,
      });
    }

    if (buildings.length === 0) return null;
    buildings.sort((a, b) => a.distance - b.distance);
    return buildings[0];
  } catch {
    return null;
  }
}
