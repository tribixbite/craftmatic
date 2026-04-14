/**
 * Shared satellite zoom calculation for Google Static Maps API.
 *
 * Used by both CLI (satellite-color.ts) and browser (building-bounds.ts)
 * to compute the optimal zoom level that fits a building into a satellite image.
 */

/** Earth circumference in meters at equator, divided by 256px tile = meters/pixel at zoom 0 */
const METERS_PER_PX_Z0 = 156543.03392;
const DEG2RAD = Math.PI / 180;

/**
 * Calculate optimal Google Static Maps zoom level to fit a building.
 *
 * The building fills ~50% of the image (2× coverage for surrounding context).
 * Latitude-aware — compensates for Mercator longitude distortion.
 *
 * @param maxExtentM  Longest dimension of the building footprint (meters)
 * @param latDeg      Latitude in degrees (for Mercator correction)
 * @param imageSize   Pixel width of the Static Maps image (default 640, API max)
 * @returns Zoom level clamped to [15, 21]
 */
export function computeSatelliteZoom(
  maxExtentM: number,
  latDeg: number,
  imageSize = 640,
): number {
  // Target: building fills ~50% of image → image covers 2× building extent
  const targetCoverageM = maxExtentM * 2.0;
  const latRad = latDeg * DEG2RAD;
  const zoomExact = Math.log2(
    imageSize * METERS_PER_PX_Z0 * Math.cos(latRad) / targetCoverageM,
  );
  // Clamp 15-21: z15 ≈ 4.8km coverage, z21 ≈ 75m coverage
  return Math.min(21, Math.max(15, Math.round(zoomExact)));
}

/**
 * Compute meters per pixel at a given zoom level and latitude.
 */
export function metersPerPixel(zoom: number, latDeg: number): number {
  return METERS_PER_PX_Z0 * Math.cos(latDeg * DEG2RAD) / Math.pow(2, zoom);
}
