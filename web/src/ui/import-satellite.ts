/**
 * Satellite tile compositor — fetches ESRI World Imagery tiles
 * and composites a 3x3 grid onto a canvas centered on lat/lng.
 * Free for non-commercial use, no API key required.
 */

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
 * Compose a satellite view centered on lat/lng.
 * Fetches a 3x3 grid of 256px tiles and composites them onto a 768x768 canvas,
 * then draws a crosshair marker at the exact property location.
 */
export async function composeSatelliteView(
  lat: number,
  lng: number,
  zoom = 18,
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

      tilePromises.push(
        fetchTile(tx, ty, zoom)
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

  // Draw crosshair marker at exact property location
  // Property position on canvas = pixel offset within center tile + 256 (center tile starts at 256,256)
  const markerX = 256 + pixelX;
  const markerY = 256 + pixelY;
  drawCrosshair(ctx, markerX, markerY);

  return canvas;
}

/** Fetch a single ESRI World Imagery tile as an HTMLImageElement */
function fetchTile(x: number, y: number, z: number): Promise<HTMLImageElement> {
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
