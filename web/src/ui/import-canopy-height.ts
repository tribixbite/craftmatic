/**
 * Meta/WRI Global Canopy Height — 1m resolution tree heights from S3 COG tiles.
 * Uses HTTP Range Requests via geotiff.js to read a single pixel value
 * without downloading the full ~30MB tile.
 *
 * Data: Meta/World Resources Institute, GEDI-aligned global canopy height.
 * Free, no auth, public S3 bucket.
 */

import { fromUrl } from 'geotiff';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CanopyHeightResult {
  /** Tree canopy height in meters at the query point, or null if no data */
  heightMeters: number | null;
}

// ─── Quadkey Computation ────────────────────────────────────────────────────

const CANOPY_ZOOM = 9;

/** Convert lat/lon to Bing Maps quadkey for the canopy height tile grid */
function latLonToQuadkey(lat: number, lon: number): string {
  const clampLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const clampLon = Math.max(-180, Math.min(180, lon));

  const mapSize = 256 << CANOPY_ZOOM;
  const x = ((clampLon + 180) / 360) * mapSize;
  const sinLat = Math.sin((clampLat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * mapSize;

  const tileX = Math.floor(Math.min(Math.max(x, 0), mapSize - 1) / 256);
  const tileY = Math.floor(Math.min(Math.max(y, 0), mapSize - 1) / 256);

  let qk = '';
  for (let i = CANOPY_ZOOM; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((tileX & mask) !== 0) digit += 1;
    if ((tileY & mask) !== 0) digit += 2;
    qk += digit;
  }
  return qk;
}

// ─── Projection ──────────────────────────────────────────────────────────────

/** Convert lat/lon (WGS84) to Web Mercator (EPSG:3857) meters */
function toWebMercator(lat: number, lon: number): [number, number] {
  const x = (lon * 20037508.34) / 180;
  const latRad = (lat * Math.PI) / 180;
  const y = (Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) * 20037508.34;
  return [x, y];
}

// ─── Query ──────────────────────────────────────────────────────────────────

/**
 * Query tree canopy height at a lat/lon from Meta/WRI 1m global dataset.
 * Issues 2 HTTP Range Requests (~100-200KB total): header + one tile block.
 * Returns height in meters, or null if no tile exists (ocean/ice).
 *
 * Tiles are in EPSG:3857 (Web Mercator), so lat/lon is projected before
 * computing the pixel offset.
 */
export async function queryCanopyHeight(
  lat: number,
  lon: number,
): Promise<CanopyHeightResult> {
  const qk = latLonToQuadkey(lat, lon);
  const url = `https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/${qk}.tif`;

  try {
    const tiff = await fromUrl(url, { allowFullFile: false });
    const image = await tiff.getImage();

    // Bounding box is in EPSG:3857 meters
    const [west, south, east, north] = image.getBoundingBox();
    const [mx, my] = toWebMercator(lat, lon);
    if (mx < west || mx > east || my < south || my > north) {
      return { heightMeters: null };
    }

    const w = image.getWidth();
    const h = image.getHeight();
    const px = Math.max(0, Math.min(w - 1, Math.floor(((mx - west) / (east - west)) * w)));
    // Y axis is inverted: north is row 0
    const py = Math.max(0, Math.min(h - 1, Math.floor(((north - my) / (north - south)) * h)));

    const data = await image.readRasters({
      window: [px, py, px + 1, py + 1],
      samples: [0],
    });

    const val = (data[0] as Float32Array)[0];
    // 0 or negative = no canopy, NaN = nodata
    if (!val || isNaN(val) || val <= 0) return { heightMeters: null };
    return { heightMeters: Math.round(val * 10) / 10 }; // 0.1m precision
  } catch {
    // 403/404 = tile doesn't exist (ocean, ice)
    return { heightMeters: null };
  }
}
