/**
 * Browser-compatible fetcher adapters for the new pipeline.
 *
 * Wraps existing browser-specific primitives (shared-geocode, import-osm,
 * fetch of SV Metadata/Static Maps) into the `ContextFetchers` /
 * `StreetViewFetchers` / `SatelliteFetcher` shapes the pipeline expects.
 *
 * All decoding goes through `createImageBitmap` + `OffscreenCanvas` so we
 * never touch `sharp` in the browser. Image fetchers populate the `rgba`
 * field so the pipeline's sniff/palette paths skip decoding entirely.
 */

import { geocodeAddress } from './shared-geocode.js';
import { searchOSMBuilding } from './import-osm.js';
import { querySolarBuildingInsights } from '@craft/gen/api/google-solar.js';
import type { ContextFetchers } from '@craft/pipeline/context/resolver.js';
import type { StreetViewFetchers, SvImageFetch } from '@craft/pipeline/capture/streetview.js';
import type {
  SatelliteFetcher,
  SatelliteImageFetch,
} from '@craft/pipeline/capture/satellite.js';

// ─── Image decode via Canvas (no sharp) ────────────────────────────────────

async function decodeToRgba(bytes: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(w || bitmap.width, h || bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return new Uint8Array(img.data.buffer);
}

// ─── Context (geocode / Solar / OSM) ───────────────────────────────────────

export function createBrowserContextFetchers(apiKey: string): ContextFetchers {
  return {
    geocode: async (address) => {
      const res = await geocodeAddress(address, apiKey);
      if (!res) throw new Error(`geocode failed: ${address}`);
      return {
        lat: res.lat,
        lng: res.lng,
        formattedAddress: res.formattedAddress,
        placeId: res.placeId || null,
        locationType: (res.locationType as 'ROOFTOP' | 'RANGE_INTERPOLATED' | 'GEOMETRIC_CENTER' | 'APPROXIMATE') ?? 'APPROXIMATE',
        viewport: res.viewport
          ? {
              sw: { lat: res.viewport.sw.lat, lon: res.viewport.sw.lng },
              ne: { lat: res.viewport.ne.lat, lon: res.viewport.ne.lng },
            }
          : null,
        bounds: res.bounds
          ? {
              sw: { lat: res.bounds.sw.lat, lon: res.bounds.sw.lng },
              ne: { lat: res.bounds.ne.lat, lon: res.bounds.ne.lng },
            }
          : null,
      };
    },
    solar: async (lat, lng) => querySolarBuildingInsights(lat, lng, apiKey),
    osm: async (lat, lng) => searchOSMBuilding(lat, lng, 50),
    osmSiblings: async () => [], // Sibling spatial scan deferred — campus detection disabled in browser for now
    smarty: async () => null,    // Smarty requires a server-side proxy for the auth token
  };
}

// ─── Street View fetchers ──────────────────────────────────────────────────

const SV_SIZE = 640;

export function createBrowserStreetViewFetchers(apiKey: string): StreetViewFetchers {
  return {
    metadata: async (lat, lng) => {
      const url = `https://maps.googleapis.com/maps/api/streetview/metadata`
        + `?location=${lat},${lng}&source=outdoor&key=${apiKey}`;
      try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const data = await resp.json() as {
          status: string;
          pano_id?: string;
          location?: { lat: number; lng: number };
        };
        if (data.status !== 'OK' || !data.pano_id || !data.location) return null;
        return {
          panoId: data.pano_id,
          panoLat: data.location.lat,
          panoLng: data.location.lng,
        };
      } catch {
        return null;
      }
    },
    image: async (panoId, heading, fov, pitch): Promise<SvImageFetch> => {
      const url = `https://maps.googleapis.com/maps/api/streetview`
        + `?size=${SV_SIZE}x${SV_SIZE}&pano=${panoId}`
        + `&heading=${heading.toFixed(1)}&pitch=${pitch}&fov=${fov}&key=${apiKey}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`SV image HTTP ${resp.status}`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const rgba = await decodeToRgba(bytes, SV_SIZE, SV_SIZE);
      return { bytes, width: SV_SIZE, height: SV_SIZE, rgba };
    },
  };
}

// ─── Satellite fetcher ─────────────────────────────────────────────────────

export function createBrowserSatelliteFetcher(apiKey: string): SatelliteFetcher {
  return async ({ lat, lng, zoom, scale, size }): Promise<SatelliteImageFetch> => {
    const url = `https://maps.googleapis.com/maps/api/staticmap`
      + `?center=${lat},${lng}&zoom=${zoom}&size=${size}x${size}`
      + `&scale=${scale}&maptype=satellite&key=${apiKey}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Static Maps HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const w = size * scale, h = size * scale;
    const rgba = await decodeToRgba(bytes, w, h);
    return { bytes, width: w, height: h, rgba };
  };
}

// ─── Unified factory ───────────────────────────────────────────────────────

export interface BrowserPipelineFetchers {
  readonly context: ContextFetchers;
  readonly streetview: StreetViewFetchers;
  readonly satellite: SatelliteFetcher;
}

export function createBrowserFetchers(apiKey: string): BrowserPipelineFetchers {
  return {
    context: createBrowserContextFetchers(apiKey),
    streetview: createBrowserStreetViewFetchers(apiKey),
    satellite: createBrowserSatelliteFetcher(apiKey),
  };
}
