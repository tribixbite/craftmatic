/**
 * Unified building bounds resolver — queries multiple data sources to determine
 * the physical footprint, bounding box, and optimal capture parameters for a
 * building at a given lat/lng.
 *
 * Priority chain:
 * 1. Solar API boundingBox (ML-detected building perimeter)
 * 2. OSM footprint polygon (community-verified geometry)
 * 3. Geocode bounds (property parcel when available at ROOFTOP level)
 * 4. Solar footprint area (with aspect ratio assumption)
 * 5. Fallback 25m × 25m (typical US residential lot)
 */

import { querySolarBuildingInsights, type SolarBuildingData } from '@craft/gen/api/google-solar.js';
import { searchOSMBuilding, type OSMBuildingData } from '@ui/import-osm.js';
import type { LatLng } from '@ui/shared-geocode.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BuildingBounds {
  /** Best-estimate building footprint width in meters */
  widthM: number;
  /** Best-estimate building footprint length in meters */
  lengthM: number;
  /** Lat/lng bounding box of the building (if available) */
  bbox: { sw: LatLng; ne: LatLng } | null;
  /** Recommended capture radius for 3D tiles (meters) */
  captureRadiusM: number;
  /** Recommended satellite zoom level (15-21) */
  satelliteZoom: number;
  /** Data sources that contributed to the result */
  sources: string[];
  /** Confidence 0-1 (higher = more precise) */
  confidence: number;
}

// ─── Geo math ───────────────────────────────────────────────────────────────

const DEG2RAD = Math.PI / 180;

/** Convert lat/lng delta to meters (haversine approximation for small distances) */
function latLngToMeters(
  sw: LatLng, ne: LatLng,
): { widthM: number; lengthM: number } {
  const midLat = (sw.lat + ne.lat) / 2;
  const cosLat = Math.cos(midLat * DEG2RAD);
  // 1 degree latitude ≈ 111,320 meters
  const lengthM = Math.abs(ne.lat - sw.lat) * 111320;
  // 1 degree longitude ≈ 111,320 × cos(lat) meters
  const widthM = Math.abs(ne.lng - sw.lng) * 111320 * cosLat;
  return { widthM, lengthM };
}

/** Calculate optimal satellite zoom for a given coverage extent */
function computeSatelliteZoom(maxExtentM: number, latDeg: number): number {
  // Target: building fills ~60% of 640px image → image covers ~1.67x extent
  const targetCoverageM = maxExtentM * 2.0;
  const latRad = latDeg * DEG2RAD;
  const zoomExact = Math.log2(640 * 156543.03392 * Math.cos(latRad) / targetCoverageM);
  return Math.min(21, Math.max(17, Math.round(zoomExact)));
}

/** Calculate optimal capture radius for 3D tiles */
function computeCaptureRadius(widthM: number, lengthM: number): number {
  // Diagonal * 0.75 + 10m buffer for surrounding context
  const diagonal = Math.sqrt(widthM * widthM + lengthM * lengthM);
  const radius = diagonal * 0.75 + 10;
  return Math.min(100, Math.max(20, Math.round(radius)));
}

// ─── Resolver ───────────────────────────────────────────────────────────────

/**
 * Resolve building bounds by querying Solar API and OSM in parallel.
 * Falls back to geocode bounds or defaults if neither source has data.
 *
 * @param lat Building latitude
 * @param lng Building longitude
 * @param apiKey Google Maps API key (for Solar API)
 * @param geocodeBounds Optional bounds from geocoding response
 */
export async function resolveBuildingBounds(
  lat: number,
  lng: number,
  apiKey: string,
  geocodeBounds?: { sw: LatLng; ne: LatLng } | null,
): Promise<BuildingBounds> {
  const sources: string[] = [];
  let widthM = 0;
  let lengthM = 0;
  let bbox: { sw: LatLng; ne: LatLng } | null = null;
  let confidence = 0;

  // Query Solar API and OSM in parallel
  const [solar, osm] = await Promise.all([
    apiKey ? querySolarBuildingInsights(lat, lng, apiKey).catch(() => null) : null,
    searchOSMBuilding(lat, lng, 50).catch(() => null),
  ]);

  // Priority 1: Solar API bounding box (ML-detected building perimeter)
  if (solar?.buildingBounds) {
    const dims = latLngToMeters(solar.buildingBounds.sw, solar.buildingBounds.ne);
    if (dims.widthM > 2 && dims.lengthM > 2) {
      widthM = dims.widthM;
      lengthM = dims.lengthM;
      bbox = solar.buildingBounds;
      confidence = 0.9;
      sources.push('solar-bbox');
    }
  }

  // Priority 2: OSM footprint polygon (community-verified geometry)
  if (widthM === 0 && osm) {
    if (osm.widthMeters > 2 && osm.lengthMeters > 2) {
      widthM = osm.widthMeters;
      lengthM = osm.lengthMeters;
      confidence = 0.85;
      sources.push('osm-footprint');
    }
  } else if (osm && osm.widthMeters > 2) {
    // Even if Solar bbox is primary, note OSM as corroborating source
    sources.push('osm-corroborate');
  }

  // Priority 3: Geocode bounds (when available at ROOFTOP level)
  if (widthM === 0 && geocodeBounds) {
    const dims = latLngToMeters(geocodeBounds.sw, geocodeBounds.ne);
    // Geocode bounds can be very large (city-level) — only trust if < 200m
    if (dims.widthM > 2 && dims.widthM < 200 && dims.lengthM > 2 && dims.lengthM < 200) {
      widthM = dims.widthM;
      lengthM = dims.lengthM;
      bbox = geocodeBounds;
      confidence = 0.6;
      sources.push('geocode-bounds');
    }
  }

  // Priority 4: Solar footprint area with aspect ratio assumption
  if (widthM === 0 && solar && solar.buildingFootprintAreaSqm > 10) {
    // Assume 1.5:1 aspect ratio (typical residential)
    const area = solar.buildingFootprintAreaSqm;
    lengthM = Math.sqrt(area * 1.5);
    widthM = area / lengthM;
    confidence = 0.5;
    sources.push('solar-area');
  }

  // Priority 5: Fallback defaults
  if (widthM === 0) {
    widthM = 25;
    lengthM = 25;
    confidence = 0.2;
    sources.push('default');
  }

  // Ensure width <= length (normalize orientation)
  if (widthM > lengthM) {
    [widthM, lengthM] = [lengthM, widthM];
  }

  const maxExtent = Math.max(widthM, lengthM);
  return {
    widthM: Math.round(widthM * 10) / 10,
    lengthM: Math.round(lengthM * 10) / 10,
    bbox,
    captureRadiusM: computeCaptureRadius(widthM, lengthM),
    satelliteZoom: computeSatelliteZoom(maxExtent, lat),
    sources,
    confidence,
  };
}
