/**
 * Cache decorators for every pipeline fetcher.
 *
 * Each wrapper is transparent: same interface in, same interface out, with
 * responses recorded to (and replayed from) an `ApiCache`. Wrapping happens
 * at the fetcher boundary rather than inside the API clients so the cache
 * sees exactly the evidence the pipeline consumes, and so `--cache-mode
 * offline` provably reaches no network at all.
 *
 * Image fetchers return `{bytes, width, height}`. Only `bytes` is stored as a
 * blob; the dimensions ride along in the key file, so a replayed image is
 * byte-identical to the recorded one.
 */

import type { ContextFetchers } from '../context/resolver.js';
import type { StreetViewFetchers, SvImageFetch } from '../capture/streetview.js';
import type { SatelliteFetcher, SatelliteImageFetch } from '../capture/satellite.js';
import { ApiCache, coordKey } from './api-cache.js';

export function cacheContextFetchers(f: ContextFetchers, cache: ApiCache): ContextFetchers {
  return {
    geocode: (address) => cache.json('geocode', () => f.geocode(address)),
    solar: (lat, lng) => cache.json(`solar-${coordKey(lat, lng)}`, () => f.solar(lat, lng)),
    osm: (lat, lng) => cache.json(`osm-${coordKey(lat, lng)}`, () => f.osm(lat, lng)),
    osmSiblings: (lat, lng, radiusM) =>
      cache.json(`osm-siblings-${coordKey(lat, lng)}-${radiusM}`, () => f.osmSiblings(lat, lng, radiusM)),
    ...(f.osmBuildingParts
      ? {
          osmBuildingParts: (lat: number, lng: number, radiusM: number) =>
            cache.json(`osm-parts-${coordKey(lat, lng)}-${radiusM}`,
              () => f.osmBuildingParts!(lat, lng, radiusM)),
        }
      : {}),
    smarty: (address) => cache.json('smarty', () => f.smarty(address)),
  };
}

/** Image payload minus its bytes — stored alongside the blob reference. */
interface ImageMeta { readonly width: number; readonly height: number }

export function cacheStreetViewFetchers(f: StreetViewFetchers, cache: ApiCache): StreetViewFetchers {
  return {
    metadata: (lat, lng) => cache.json(`sv-meta-${coordKey(lat, lng)}`, () => f.metadata(lat, lng)),
    image: async (panoId, heading, fov, pitch) => {
      const key = `sv-img-${panoId}-${Math.round(heading)}-${Math.round(fov)}-${Math.round(pitch)}`;
      // Dimensions and bytes are cached under sibling keys so both replay.
      let meta: ImageMeta | null = null;
      const bytes = await cache.bytes(key, async () => {
        const res = await f.image(panoId, heading, fov, pitch);
        meta = { width: res.width, height: res.height };
        return res.bytes;
      });
      const dims = await cache.json<ImageMeta>(`${key}-dims`, async () => {
        if (meta) return meta;
        // Bytes replayed from cache but dims missing (older cache): re-fetch
        // metadata only. In offline mode `cache.json` throws instead.
        const res = await f.image(panoId, heading, fov, pitch);
        return { width: res.width, height: res.height };
      });
      return { bytes, width: dims.width, height: dims.height } satisfies SvImageFetch;
    },
  };
}

export function cacheSatelliteFetcher(f: SatelliteFetcher, cache: ApiCache): SatelliteFetcher {
  return async (input) => {
    const key = `sat-${coordKey(input.lat, input.lng)}-z${input.zoom}-s${input.scale}-${input.size}`;
    let meta: ImageMeta | null = null;
    const bytes = await cache.bytes(key, async () => {
      const res = await f(input);
      meta = { width: res.width, height: res.height };
      return res.bytes;
    });
    const dims = await cache.json<ImageMeta>(`${key}-dims`, async () => {
      if (meta) return meta;
      const res = await f(input);
      return { width: res.width, height: res.height };
    });
    return { bytes, width: dims.width, height: dims.height } satisfies SatelliteImageFetch;
  };
}
