/**
 * Satellite tile compositor — fetches ESRI World Imagery tiles
 * and composites a 3x3 grid onto a canvas centered on lat/lng.
 * Free for non-commercial use, no API key required.
 *
 * Includes seasonal weather overlay based on current date + latitude.
 */

/** Seasonal weather type derived from date and location */
export type SeasonalWeather = 'snow' | 'spring' | 'summer' | 'fall';

/** Tile fetcher function signature — used to swap ESRI/Mapbox tile sources */
export type TileFetcher = (x: number, y: number, z: number) => Promise<HTMLImageElement>;

/** Convert lat/lng to slippy map tile coordinates at a given zoom level */
export function latLngToTile(
  lat: number,
  lng: number,
  zoom: number,
): { tileX: number; tileY: number; pixelX: number; pixelY: number } {
  const n = Math.pow(2, zoom);
  const latRad = (lat * Math.PI) / 180;

  // Fractional tile coordinates
  const xFrac = ((lng + 180) / 360) * n;
  const yFrac = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;

  const tileX = Math.floor(xFrac);
  const tileY = Math.floor(yFrac);

  // Pixel offset within the tile (256px tiles)
  const pixelX = Math.floor((xFrac - tileX) * 256);
  const pixelY = Math.floor((yFrac - tileY) * 256);

  return { tileX, tileY, pixelX, pixelY };
}

/**
 * Determine seasonal weather from current date and latitude.
 * Northern hemisphere seasons; southern hemisphere is inverted.
 * Subtropical/tropical latitudes (|lat| < 28) default to summer.
 */
export function getSeasonalWeather(lat: number, date = new Date()): SeasonalWeather {
  const month = date.getMonth(); // 0-11
  const isSouthern = lat < 0;
  // 28° covers subtropical zones (South FL, Gulf Coast, Hawaii, etc.)
  const isTropical = Math.abs(lat) < 28;

  if (isTropical) return 'summer';

  // Northern hemisphere month→season, inverted for southern
  let season: SeasonalWeather;
  if (month >= 2 && month <= 4) season = 'spring';
  else if (month >= 5 && month <= 7) season = 'summer';
  else if (month >= 8 && month <= 10) season = 'fall';
  else season = 'snow'; // Dec, Jan, Feb

  // Invert for southern hemisphere
  if (isSouthern) {
    const invert: Record<SeasonalWeather, SeasonalWeather> = {
      spring: 'fall', summer: 'snow', fall: 'spring', snow: 'summer',
    };
    season = invert[season];
  }

  return season;
}

/**
 * Compose a satellite view centered on lat/lng.
 * Fetches a 3x3 grid of 256px tiles and composites them onto a 768x768 canvas,
 * then draws a crosshair marker at the exact property location and applies
 * a seasonal weather overlay tint.
 */
export async function composeSatelliteView(
  lat: number,
  lng: number,
  zoom = 18,
  tileFetcher?: TileFetcher,
): Promise<HTMLCanvasElement> {
  const { tileX, tileY, pixelX, pixelY } = latLngToTile(lat, lng, zoom);

  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 768;
  const ctx = canvas.getContext('2d')!;

  // Fill with dark background while tiles load
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, 768, 768);

  // Fetch 3x3 tile grid (center tile = tileX, tileY)
  const tilePromises: Promise<{ img: HTMLImageElement; dx: number; dy: number } | null>[] = [];
  for (let row = -1; row <= 1; row++) {
    for (let col = -1; col <= 1; col++) {
      const tx = tileX + col;
      const ty = tileY + row;
      const dx = (col + 1) * 256;
      const dy = (row + 1) * 256;

      const fetcher = tileFetcher ?? fetchEsriTile;
      tilePromises.push(
        fetcher(tx, ty, zoom)
          .then(img => ({ img, dx, dy }))
          .catch(() => null),
      );
    }
  }

  const results = await Promise.allSettled(tilePromises);

  // Draw loaded tiles onto canvas
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      const { img, dx, dy } = result.value;
      ctx.drawImage(img, dx, dy, 256, 256);
    }
  }

  // Apply seasonal weather overlay tint
  const season = getSeasonalWeather(lat);
  drawSeasonOverlay(ctx, 768, 768, season);

  // Draw crosshair marker at exact property location
  // Property position on canvas = pixel offset within center tile + 256 (center tile starts at 256,256)
  const markerX = 256 + pixelX;
  const markerY = 256 + pixelY;
  drawCrosshair(ctx, markerX, markerY);

  // Store season on canvas element for external use
  canvas.dataset['season'] = season;

  return canvas;
}

/** Apply a translucent seasonal color overlay to the canvas */
function drawSeasonOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  season: SeasonalWeather,
): void {
  // Subtle tint that doesn't obscure satellite imagery
  const overlays: Record<SeasonalWeather, { color: string; opacity: number }> = {
    snow: { color: '200, 220, 255', opacity: 0.15 },   // Cool blue-white
    spring: { color: '100, 200, 100', opacity: 0.08 },  // Light green
    summer: { color: '255, 200, 50', opacity: 0.06 },   // Warm gold
    fall: { color: '200, 120, 50', opacity: 0.10 },     // Amber-orange
  };

  const { color, opacity } = overlays[season];
  ctx.fillStyle = `rgba(${color}, ${opacity})`;
  ctx.fillRect(0, 0, w, h);

  // Snow gets scattered white dots
  if (season === 'snow') {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    // Deterministic pseudo-random snow positions from canvas size
    for (let i = 0; i < 200; i++) {
      const x = (i * 7919 + 1301) % w;
      const y = (i * 6271 + 3037) % h;
      const r = ((i * 31) % 3) + 1;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Fetch a single ESRI World Imagery tile as an HTMLImageElement */
export function fetchEsriTile(x: number, y: number, z: number): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Tile ${z}/${y}/${x} failed`));
    img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  });
}

/** Draw a crosshair + circle marker at the given canvas position */
function drawCrosshair(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const size = 20;
  const lineWidth = 2;

  // Outer glow
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.lineWidth = lineWidth + 2;
  drawCrosshairLines(ctx, x, y, size);

  // Inner bright crosshair
  ctx.strokeStyle = '#ff4444';
  ctx.lineWidth = lineWidth;
  drawCrosshairLines(ctx, x, y, size);

  // Circle around center
  ctx.beginPath();
  ctx.arc(x, y, size * 0.6, 0, Math.PI * 2);
  ctx.strokeStyle = '#ff4444';
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

/** Draw the four crosshair lines (gap in center) */
function drawCrosshairLines(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const gap = 4;
  ctx.beginPath();
  // Top
  ctx.moveTo(x, y - size);
  ctx.lineTo(x, y - gap);
  // Bottom
  ctx.moveTo(x, y + gap);
  ctx.lineTo(x, y + size);
  // Left
  ctx.moveTo(x - size, y);
  ctx.lineTo(x - gap, y);
  // Right
  ctx.moveTo(x + gap, y);
  ctx.lineTo(x + size, y);
  ctx.stroke();
}
