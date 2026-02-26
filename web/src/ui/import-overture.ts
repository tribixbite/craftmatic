/**
 * Overture Maps building data — queries global building attributes (height, floors,
 * roof shape, facade material/color) from Overture Maps PMTiles.
 *
 * Uses HTTP Range Requests to read MVT tiles directly from the S3-hosted PMTiles
 * archive. No API key required. Data sourced from OSM + ML-derived attributes.
 *
 * The extras bucket has CORS enabled for browser access.
 */

import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OvertureBuildingData {
  /** Overture feature ID (GERS) */
  id: string;
  /** Building height in meters */
  height?: number;
  /** Number of above-ground floors */
  numFloors?: number;
  /** Roof shape: gable, hip, flat, gambrel, etc. */
  roofShape?: string;
  /** Roof material: metal, concrete, roof_tiles, etc. */
  roofMaterial?: string;
  /** Roof color as hex #rrggbb */
  roofColor?: string;
  /** Facade/wall material */
  facadeMaterial?: string;
  /** Facade/wall color as hex #rrggbb */
  facadeColor?: string;
  /** Building subtype: residential, commercial, industrial, etc. */
  subtype?: string;
  /** Building class: house, apartments, retail, etc. */
  buildingClass?: string;
  /** Distance from query point to feature centroid (meters) */
  distanceMeters: number;
}

// ─── PMTiles Client ─────────────────────────────────────────────────────────

/** Overture Maps buildings PMTiles — CORS-enabled extras bucket */
const OVERTURE_URL =
  'https://overturemaps-extras-us-west-2.s3.amazonaws.com/tiles/2026-02-18.0/buildings.pmtiles';

/** Singleton instance — reuses internal HTTP cache across lookups */
let pmInstance: PMTiles | null = null;

function getPM(): PMTiles {
  if (!pmInstance) pmInstance = new PMTiles(OVERTURE_URL);
  return pmInstance;
}

/** Convert lat/lon to z14 slippy map tile coordinates */
function latLonToTile(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

/** Haversine distance in meters between two lat/lon points */
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

// ─── Query ──────────────────────────────────────────────────────────────────

/**
 * Query the closest Overture Maps building to a lat/lon point.
 * Fetches a z14 MVT tile via HTTP Range Requests and finds the nearest feature.
 *
 * Full building attributes (height, floors, roof, facade) are only at zoom 14.
 * Returns null if no building tile exists or no buildings within 100m.
 */
export async function queryOvertureBuilding(
  lat: number,
  lon: number,
): Promise<OvertureBuildingData | null> {
  const zoom = 14;
  const { x, y } = latLonToTile(lat, lon, zoom);

  try {
    const pm = getPM();
    const resp = await pm.getZxy(zoom, x, y, AbortSignal.timeout(15000));
    if (!resp?.data) return null;

    // Decode MVT tile
    const tile = new VectorTile(new Pbf(new Uint8Array(resp.data)));
    const layer = tile.layers['building'];
    if (!layer) return null;

    let closest: OvertureBuildingData | null = null;
    let closestDist = 100; // max 100m threshold

    for (let i = 0; i < layer.length; i++) {
      const feat = layer.feature(i);
      const geo = feat.toGeoJSON(x, y, zoom);

      // Compute rough centroid
      let cLon: number, cLat: number;
      if (geo.geometry.type === 'Polygon') {
        const ring = geo.geometry.coordinates[0];
        cLon = ring.reduce((s: number, c: number[]) => s + c[0], 0) / ring.length;
        cLat = ring.reduce((s: number, c: number[]) => s + c[1], 0) / ring.length;
      } else if (geo.geometry.type === 'MultiPolygon') {
        const ring = geo.geometry.coordinates[0][0];
        cLon = ring.reduce((s: number, c: number[]) => s + c[0], 0) / ring.length;
        cLat = ring.reduce((s: number, c: number[]) => s + c[1], 0) / ring.length;
      } else {
        continue;
      }

      const dist = haversineM(lat, lon, cLat, cLon);
      if (dist < closestDist) {
        closestDist = dist;
        const p = feat.properties;
        closest = {
          id: String(p['id'] ?? ''),
          height: typeof p['height'] === 'number' ? p['height'] : undefined,
          numFloors: typeof p['num_floors'] === 'number' ? p['num_floors'] : undefined,
          roofShape: typeof p['roof_shape'] === 'string' ? p['roof_shape'] : undefined,
          roofMaterial: typeof p['roof_material'] === 'string' ? p['roof_material'] : undefined,
          roofColor: typeof p['roof_color'] === 'string' ? p['roof_color'] : undefined,
          facadeMaterial: typeof p['facade_material'] === 'string' ? p['facade_material'] : undefined,
          facadeColor: typeof p['facade_color'] === 'string' ? p['facade_color'] : undefined,
          subtype: typeof p['subtype'] === 'string' ? p['subtype'] : undefined,
          buildingClass: typeof p['class'] === 'string' ? p['class'] : undefined,
          distanceMeters: dist,
        };
      }
    }

    return closest;
  } catch {
    return null;
  }
}
