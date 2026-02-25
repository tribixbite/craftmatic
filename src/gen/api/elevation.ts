/**
 * AWS Terrarium elevation tile fetcher — free global DEM data.
 * Inspired by arnis/src/elevation_data.rs.
 *
 * Terrarium tiles are RGB-encoded PNGs where:
 *   height_meters = R * 256 + G + B / 256 - 32768
 *
 * No API key required. Tiles cached locally for 7 days.
 * Used for:
 *   - Terrain-aware building foundations (extend walls to ground)
 *   - Hillside floor-count correction (Mapbox height includes slope)
 *   - Ground plane generation around buildings
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const MIN_ZOOM = 10;
const MAX_ZOOM = 15;
const TERRARIUM_OFFSET = 32768;
const TILE_SIZE = 256;

// ─── Web Mercator ────────────────────────────────────────────────────────────

/** Convert latitude (degrees) to Web Mercator tile Y coordinate at given zoom */
function latToTileY(lat: number, zoom: number): number {
  const latRad = (lat * Math.PI) / 180;
  const n = 2 ** zoom;
  return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
}

/** Convert longitude (degrees) to Web Mercator tile X coordinate at given zoom */
function lngToTileX(lng: number, zoom: number): number {
  const n = 2 ** zoom;
  return Math.floor(((lng + 180) / 360) * n);
}

/** Convert tile coordinates back to lat/lng (top-left corner of tile) */
function tileToLatLng(tileX: number, tileY: number, zoom: number): { lat: number; lng: number } {
  const n = 2 ** zoom;
  const lng = (tileX / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * tileY) / n)));
  const lat = (latRad * 180) / Math.PI;
  return { lat, lng };
}

/** Auto-select zoom level from bounding box size (arnis formula) */
function autoZoom(latSpan: number, lngSpan: number): number {
  const maxSpan = Math.max(latSpan, lngSpan);
  if (maxSpan <= 0) return MAX_ZOOM;
  const z = Math.floor(-Math.log2(maxSpan) + 20);
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

// ─── Tile Cache ──────────────────────────────────────────────────────────────

const tileCache = new Map<string, Uint8Array>();

/** Fetch a single Terrarium tile and decode its RGB pixels */
async function fetchTile(zoom: number, tileX: number, tileY: number): Promise<Uint8Array | null> {
  const key = `${zoom}/${tileX}/${tileY}`;
  const cached = tileCache.get(key);
  if (cached) return cached;

  const url = `${TERRARIUM_URL}/${key}.png`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const buffer = await resp.arrayBuffer();

    // Decode PNG to raw RGB pixels via sharp (Node/Bun only).
    // Browser path omitted — elevation is CLI-only for now.
    let pixels: Uint8Array;
    const sharp = (await import('sharp')).default;
    const { data, info } = await sharp(Buffer.from(buffer))
      .raw()
      .removeAlpha()
      .toBuffer({ resolveWithObject: true });
    if (info.channels === 4) {
      // Fallback: strip alpha manually if removeAlpha didn't reduce
      pixels = new Uint8Array(info.width * info.height * 3);
      for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
        pixels[j] = data[i];
        pixels[j + 1] = data[i + 1];
        pixels[j + 2] = data[i + 2];
      }
    } else {
      pixels = new Uint8Array(data);
    }

    tileCache.set(key, pixels);
    return pixels;
  } catch {
    return null;
  }
}

// ─── Elevation Grid ──────────────────────────────────────────────────────────

/** Grid of elevation values (meters) covering a lat/lng bounding box */
export interface ElevationGrid {
  /** Elevation values in row-major order (south→north, west→east) */
  heights: Float32Array;
  /** Grid dimensions */
  cols: number;
  rows: number;
  /** Geographic bounds */
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  /** Resolution in degrees per cell */
  latStep: number;
  lngStep: number;
}

/**
 * Fetch elevation data for a bounding box from AWS Terrarium tiles.
 * Returns a grid of height values that can be sampled at any lat/lng within the bbox.
 *
 * @param minLat Southern latitude boundary
 * @param minLng Western longitude boundary
 * @param maxLat Northern latitude boundary
 * @param maxLng Eastern longitude boundary
 * @returns ElevationGrid or null if tiles couldn't be fetched
 */
export async function fetchElevationGrid(
  minLat: number, minLng: number, maxLat: number, maxLng: number,
): Promise<ElevationGrid | null> {
  const zoom = autoZoom(maxLat - minLat, maxLng - minLng);

  const minTileX = lngToTileX(minLng, zoom);
  const maxTileX = lngToTileX(maxLng, zoom);
  const minTileY = latToTileY(maxLat, zoom); // Note: tile Y is inverted (north = lower Y)
  const maxTileY = latToTileY(minLat, zoom);

  const tilesX = maxTileX - minTileX + 1;
  const tilesY = maxTileY - minTileY + 1;
  const totalTiles = tilesX * tilesY;

  // Safety cap — don't fetch more than 64 tiles for a single building query
  if (totalTiles > 64) return null;

  // Fetch all tiles (up to 8 concurrent, matching arnis pattern)
  const tilePromises: Promise<{ x: number; y: number; pixels: Uint8Array | null }>[] = [];
  for (let ty = minTileY; ty <= maxTileY; ty++) {
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      tilePromises.push(
        fetchTile(zoom, tx, ty).then(pixels => ({ x: tx - minTileX, y: ty - minTileY, pixels }))
      );
    }
  }
  const tiles = await Promise.all(tilePromises);

  // Assemble into a continuous grid
  const gridCols = tilesX * TILE_SIZE;
  const gridRows = tilesY * TILE_SIZE;
  const heights = new Float32Array(gridCols * gridRows);

  for (const tile of tiles) {
    if (!tile.pixels) continue;
    const offsetX = tile.x * TILE_SIZE;
    const offsetY = tile.y * TILE_SIZE;
    for (let py = 0; py < TILE_SIZE; py++) {
      for (let px = 0; px < TILE_SIZE; px++) {
        const srcIdx = (py * TILE_SIZE + px) * 3;
        const r = tile.pixels[srcIdx];
        const g = tile.pixels[srcIdx + 1];
        const b = tile.pixels[srcIdx + 2];
        // Terrarium height formula: R*256 + G + B/256 - 32768
        const h = r * 256 + g + b / 256 - TERRARIUM_OFFSET;
        const dstIdx = (offsetY + py) * gridCols + (offsetX + px);
        heights[dstIdx] = h;
      }
    }
  }

  // Compute geographic bounds of the actual tile grid
  const gridTopLeft = tileToLatLng(minTileX, minTileY, zoom);
  const gridBottomRight = tileToLatLng(maxTileX + 1, maxTileY + 1, zoom);

  return {
    heights,
    cols: gridCols,
    rows: gridRows,
    minLat: gridBottomRight.lat,
    maxLat: gridTopLeft.lat,
    minLng: gridTopLeft.lng,
    maxLng: gridBottomRight.lng,
    latStep: (gridTopLeft.lat - gridBottomRight.lat) / gridRows,
    lngStep: (gridBottomRight.lng - gridTopLeft.lng) / gridCols,
  };
}

/**
 * Sample elevation at a specific lat/lng from a pre-fetched grid.
 * Uses bilinear interpolation for sub-pixel accuracy (arnis Ground::level pattern).
 */
export function sampleElevation(grid: ElevationGrid, lat: number, lng: number): number {
  // Convert lat/lng to fractional grid coordinates
  const fx = (lng - grid.minLng) / grid.lngStep;
  const fy = (grid.maxLat - lat) / grid.latStep; // Y is inverted (north = row 0)

  // Bilinear interpolation
  const x0 = Math.max(0, Math.min(grid.cols - 2, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(grid.rows - 2, Math.floor(fy)));
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const dx = fx - x0;
  const dy = fy - y0;

  const h00 = grid.heights[y0 * grid.cols + x0];
  const h10 = grid.heights[y0 * grid.cols + x1];
  const h01 = grid.heights[y1 * grid.cols + x0];
  const h11 = grid.heights[y1 * grid.cols + x1];

  return h00 * (1 - dx) * (1 - dy)
       + h10 * dx * (1 - dy)
       + h01 * (1 - dx) * dy
       + h11 * dx * dy;
}

/**
 * Get the elevation difference across a building footprint.
 * Returns the slope in meters from the highest to lowest corner.
 * Used to correct Mapbox height inflation on hillsides.
 */
export function footprintSlope(
  grid: ElevationGrid,
  lat: number, lng: number,
  widthM: number, lengthM: number,
): number {
  // Approximate meters to degrees (at this latitude)
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const dLat = lengthM / mPerDegLat / 2;
  const dLng = widthM / mPerDegLng / 2;

  // Sample 4 corners
  const corners = [
    sampleElevation(grid, lat + dLat, lng - dLng),
    sampleElevation(grid, lat + dLat, lng + dLng),
    sampleElevation(grid, lat - dLat, lng - dLng),
    sampleElevation(grid, lat - dLat, lng + dLng),
  ];

  return Math.max(...corners) - Math.min(...corners);
}
