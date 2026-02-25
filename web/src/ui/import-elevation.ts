/**
 * Browser-compatible elevation tile fetcher — decodes Terrarium PNG tiles
 * using Canvas2D instead of sharp. Provides the same interface as the CLI's
 * src/gen/api/elevation.ts (ElevationGrid, sampleElevation, footprintSlope).
 *
 * AWS Terrarium tiles: RGB-encoded PNGs, height = R*256 + G + B/256 - 32768.
 * No API key required. Used for terrain-aware building foundations and
 * hillside Mapbox height correction.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const MIN_ZOOM = 10;
const MAX_ZOOM = 15;
const TERRARIUM_OFFSET = 32768;
const TILE_SIZE = 256;

// ─── Web Mercator ────────────────────────────────────────────────────────────

function latToTileY(lat: number, zoom: number): number {
  const latRad = (lat * Math.PI) / 180;
  const n = 2 ** zoom;
  return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
}

function lngToTileX(lng: number, zoom: number): number {
  const n = 2 ** zoom;
  return Math.floor(((lng + 180) / 360) * n);
}

function tileToLatLng(tileX: number, tileY: number, zoom: number): { lat: number; lng: number } {
  const n = 2 ** zoom;
  const lng = (tileX / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * tileY) / n)));
  const lat = (latRad * 180) / Math.PI;
  return { lat, lng };
}

function autoZoom(latSpan: number, lngSpan: number): number {
  const maxSpan = Math.max(latSpan, lngSpan);
  if (maxSpan <= 0) return MAX_ZOOM;
  const z = Math.floor(-Math.log2(maxSpan) + 20);
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

// ─── Tile Cache ──────────────────────────────────────────────────────────────

const tileCache = new Map<string, Uint8Array>();

/** Fetch a single Terrarium tile and decode RGB pixels via Canvas2D */
async function fetchTile(zoom: number, tileX: number, tileY: number): Promise<Uint8Array | null> {
  const key = `${zoom}/${tileX}/${tileY}`;
  const cached = tileCache.get(key);
  if (cached) return cached;

  const url = `${TERRARIUM_URL}/${key}.png`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return null;

    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close(); return null; }

    ctx.drawImage(bitmap, 0, 0);
    const imgData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();

    // Extract RGB (skip alpha) into packed RGB array
    const rgba = imgData.data;
    const pixelCount = bitmap.width * bitmap.height;
    const rgb = new Uint8Array(pixelCount * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }

    tileCache.set(key, rgb);
    return rgb;
  } catch {
    return null;
  }
}

// ─── Elevation Grid ──────────────────────────────────────────────────────────

/** Grid of elevation values (meters) covering a lat/lng bounding box */
export interface ElevationGrid {
  heights: Float32Array;
  cols: number;
  rows: number;
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  latStep: number;
  lngStep: number;
}

/**
 * Fetch elevation data for a bounding box from AWS Terrarium tiles.
 * Browser-compatible: uses Canvas2D for PNG decoding.
 */
export async function fetchElevationGrid(
  minLat: number, minLng: number, maxLat: number, maxLng: number,
): Promise<ElevationGrid | null> {
  const zoom = autoZoom(maxLat - minLat, maxLng - minLng);

  const minTileX = lngToTileX(minLng, zoom);
  const maxTileX = lngToTileX(maxLng, zoom);
  const minTileY = latToTileY(maxLat, zoom);
  const maxTileY = latToTileY(minLat, zoom);

  const tilesX = maxTileX - minTileX + 1;
  const tilesY = maxTileY - minTileY + 1;
  if (tilesX * tilesY > 16) return null; // Browser-safe cap

  const tilePromises: Promise<{ x: number; y: number; pixels: Uint8Array | null }>[] = [];
  for (let ty = minTileY; ty <= maxTileY; ty++) {
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      tilePromises.push(
        fetchTile(zoom, tx, ty).then(pixels => ({ x: tx - minTileX, y: ty - minTileY, pixels }))
      );
    }
  }
  const tiles = await Promise.all(tilePromises);

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
        const h = r * 256 + g + b / 256 - TERRARIUM_OFFSET;
        const dstIdx = (offsetY + py) * gridCols + (offsetX + px);
        heights[dstIdx] = h;
      }
    }
  }

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

/** Sample elevation at a specific lat/lng using bilinear interpolation */
export function sampleElevation(grid: ElevationGrid, lat: number, lng: number): number {
  const fx = (lng - grid.minLng) / grid.lngStep;
  const fy = (grid.maxLat - lat) / grid.latStep;

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

/** Get elevation difference across a building footprint (meters) */
export function footprintSlope(
  grid: ElevationGrid,
  lat: number, lng: number,
  widthM: number, lengthM: number,
): number {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const dLat = lengthM / mPerDegLat / 2;
  const dLng = widthM / mPerDegLng / 2;

  const corners = [
    sampleElevation(grid, lat + dLat, lng - dLng),
    sampleElevation(grid, lat + dLat, lng + dLng),
    sampleElevation(grid, lat - dLat, lng - dLng),
    sampleElevation(grid, lat - dLat, lng + dLng),
  ];

  return Math.max(...corners) - Math.min(...corners);
}
