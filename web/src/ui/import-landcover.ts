/**
 * ESA WorldCover 2021 — 10m land cover classification at a lat/lon.
 * Uses HTTP Range Requests via geotiff.js to read a single pixel
 * from S3-hosted Cloud-Optimized GeoTIFF tiles.
 *
 * Returns one of 11 land cover classes (tree cover, grassland, water, etc.).
 * Free, no auth, global 10m resolution.
 */

import { fromUrl } from 'geotiff';

// ─── Types ──────────────────────────────────────────────────────────────────

/** ESA WorldCover 2021 land cover classes */
export const LAND_COVER_CLASSES: Record<number, string> = {
  10: 'Tree cover',
  20: 'Shrubland',
  30: 'Grassland',
  40: 'Cropland',
  50: 'Built-up',
  60: 'Bare / sparse vegetation',
  70: 'Snow and ice',
  80: 'Permanent water bodies',
  90: 'Herbaceous wetland',
  95: 'Mangroves',
  100: 'Moss and lichen',
};

export interface LandCoverResult {
  /** Raw class value (10-100), or null if no data */
  classValue: number | null;
  /** Human-readable label */
  label: string | null;
}

// ─── Tile URL ───────────────────────────────────────────────────────────────

/** Build ESA WorldCover tile URL for a lat/lon (3x3 degree tiles, named by SW corner) */
function worldCoverTileUrl(lat: number, lon: number): string {
  const tileLat = Math.floor(lat / 3) * 3;
  const tileLon = Math.floor(lon / 3) * 3;
  const ns = tileLat >= 0 ? 'N' : 'S';
  const ew = tileLon >= 0 ? 'E' : 'W';
  const latStr = String(Math.abs(tileLat)).padStart(2, '0');
  const lonStr = String(Math.abs(tileLon)).padStart(3, '0');
  return `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_${ns}${latStr}${ew}${lonStr}_Map.tif`;
}

// ─── Query ──────────────────────────────────────────────────────────────────

/**
 * Query ESA WorldCover 2021 land cover class at a lat/lon.
 * Issues 2 HTTP Range Requests (~70-200KB total).
 * Returns class value + label, or null if no tile exists (ocean).
 */
export async function queryLandCover(
  lat: number,
  lon: number,
): Promise<LandCoverResult> {
  const url = worldCoverTileUrl(lat, lon);

  try {
    const tiff = await fromUrl(url, { allowFullFile: false });
    const image = await tiff.getImage();

    const [west, south, east, north] = image.getBoundingBox();
    if (lon < west || lon > east || lat < south || lat > north) {
      return { classValue: null, label: null };
    }

    const w = image.getWidth();
    const h = image.getHeight();
    const px = Math.max(0, Math.min(w - 1, Math.floor(((lon - west) / (east - west)) * w)));
    const py = Math.max(0, Math.min(h - 1, Math.floor(((north - lat) / (north - south)) * h)));

    const data = await image.readRasters({
      window: [px, py, px + 1, py + 1],
      samples: [0],
    });

    const val = (data[0] as Uint8Array)[0];
    if (!val || val === 0) return { classValue: null, label: null };
    return {
      classValue: val,
      label: LAND_COVER_CLASSES[val] ?? 'Unknown',
    };
  } catch {
    // 403/404 = tile doesn't exist (ocean)
    return { classValue: null, label: null };
  }
}
