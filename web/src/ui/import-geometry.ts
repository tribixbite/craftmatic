/**
 * Geometry helpers for the import tab — tile math, building polygon rendering,
 * and Street View DOM insertion.
 */

import type { GeocodingResult } from '@ui/import-geocoder.js';

/**
 * Get tile coordinates (integer tile indices) for a given lat/lng at a zoom level.
 * Used by satellite composition and polygon overlay to map lat/lng to the
 * 3x3 tile grid that forms the 768x768 canvas.
 */
export function getTileCoords(
  lat: number,
  lng: number,
  zoom: number,
): { tileX: number; tileY: number } {
  const n = Math.pow(2, zoom);
  const latRad = (lat * Math.PI) / 180;
  const xFrac = ((lng + 180) / 360) * n;
  const yFrac = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { tileX: Math.floor(xFrac), tileY: Math.floor(yFrac) };
}

/**
 * Get the crosshair pixel position on the 768x768 satellite canvas.
 * Re-derives from lat/lng at zoom 18 (same as composeSatelliteView).
 */
export function getCrosshairPosition(
  lat: number,
  lng: number,
): { pixelX: number; pixelY: number } {
  const zoom = 18;
  const n = Math.pow(2, zoom);
  const latRad = (lat * Math.PI) / 180;
  const xFrac = ((lng + 180) / 360) * n;
  const yFrac = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tileX = Math.floor(xFrac);
  const tileY = Math.floor(yFrac);
  // Pixel offset within the center tile + 256 (center tile starts at 256,256)
  const pixelX = 256 + Math.floor((xFrac - tileX) * 256);
  const pixelY = 256 + Math.floor((yFrac - tileY) * 256);
  return { pixelX, pixelY };
}

/**
 * Draw the OSM building polygon outline on the satellite canvas.
 * Converts lat/lng polygon vertices to canvas pixel coordinates.
 */
export function drawBuildingOutline(
  canvas: HTMLCanvasElement,
  geo: GeocodingResult,
  polygon: { lat: number; lon: number }[],
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx || polygon.length < 3) return;

  const zoom = 18;
  const n = Math.pow(2, zoom);
  const { tileX, tileY } = getTileCoords(geo.lat, geo.lng, zoom);

  ctx.save();
  ctx.strokeStyle = 'rgba(88, 101, 242, 0.8)';
  ctx.fillStyle = 'rgba(88, 101, 242, 0.12)';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';

  ctx.beginPath();
  for (let i = 0; i < polygon.length; i++) {
    const pt = polygon[i];
    const latRad = (pt.lat * Math.PI) / 180;
    const xFrac = ((pt.lon + 180) / 360) * n;
    const yFrac = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    // Canvas position: offset from center tile origin (tile at index 1,1 in the 3x3 grid)
    const px = (xFrac - tileX + 1) * 256;
    const py = (yFrac - tileY + 1) * 256;

    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * Append a Street View image below the satellite canvas in the viewer.
 * Self-contained DOM helper — creates the container, label, and img element.
 */
export function appendStreetViewImage(container: HTMLElement, url: string): void {
  const wrapper = container.querySelector('.import-satellite-wrapper');
  if (!wrapper) return;

  const svContainer = document.createElement('div');
  svContainer.className = 'import-streetview-container';

  const label = document.createElement('div');
  label.className = 'import-satellite-overlay';
  label.style.top = '12px';
  label.style.bottom = 'auto';
  label.textContent = 'Street View';

  const img = document.createElement('img');
  img.className = 'import-streetview-img';
  img.src = url;
  img.alt = 'Street View';
  img.loading = 'lazy';

  svContainer.appendChild(label);
  svContainer.appendChild(img);

  // Insert after the satellite wrapper
  wrapper.parentElement?.appendChild(svContainer);
}
