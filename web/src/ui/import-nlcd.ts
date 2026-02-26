/**
 * NLCD Tree Canopy Cover — queries MRLC WMS for tree canopy percentage (0–99%)
 * at a given lat/lon. 30m resolution, CONUS coverage.
 * Free, no auth required, public domain (US Government).
 *
 * Uses NLCD 2021 Tree Canopy Cover layer via WMS GetFeatureInfo.
 * The PALETTE_INDEX value = canopy cover percentage.
 */

/** MRLC GeoServer WMS endpoint for NLCD Tree Canopy Cover 2021 */
const MRLC_WMS_URL = 'https://www.mrlc.gov/geoserver/mrlc_display/wms';
const TCC_LAYER = 'nlcd_tcc_conus_2021_v2021-4';

export interface NlcdCanopyResult {
  /** Tree canopy cover percentage (0–99), or null if outside CONUS */
  canopyCoverPct: number | null;
}

/**
 * Query NLCD tree canopy cover at a point via WMS GetFeatureInfo.
 * Returns 0–99 canopy %, or null if the point is outside coverage.
 *
 * Creates a tiny 3x3 pixel WMS window centered on the point and queries
 * the center pixel via GetFeatureInfo.
 */
export async function queryNlcdCanopy(
  lat: number,
  lon: number,
): Promise<NlcdCanopyResult> {
  // Create a tiny bbox centered on the point (~30m at equator per pixel)
  const d = 0.0005; // ~55m in each direction
  const bbox = `${lon - d},${lat - d},${lon + d},${lat + d}`;

  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.1.1',
    request: 'GetFeatureInfo',
    layers: TCC_LAYER,
    query_layers: TCC_LAYER,
    info_format: 'application/json',
    x: '1',
    y: '1',
    width: '3',
    height: '3',
    srs: 'EPSG:4326',
    bbox,
  });

  try {
    const res = await fetch(`${MRLC_WMS_URL}?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { canopyCoverPct: null };

    const data = await res.json() as {
      features?: { properties?: { PALETTE_INDEX?: number } }[];
    };

    const val = data.features?.[0]?.properties?.PALETTE_INDEX;
    if (val == null || val < 0 || val > 99) return { canopyCoverPct: null };

    return { canopyCoverPct: val };
  } catch {
    return { canopyCoverPct: null };
  }
}
