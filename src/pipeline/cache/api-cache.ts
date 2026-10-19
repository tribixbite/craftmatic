/**
 * Durable cache of every API-drawn input the pipeline consumes.
 *
 * Motivation: the pipeline's evidence comes from paid/rate-limited/flaky
 * third parties (Google Geocoding, Solar, Street View, Static Maps; OSM
 * Overpass). Two Overpass outages in one day produced invented buildings and
 * destroyed a verified pass. Beyond reliability, iterating on synthesis,
 * recolor or overlay code does not need live APIs at all — the same address
 * should re-resolve to byte-identical evidence every time so a code change is
 * the ONLY variable.
 *
 * This module records every response to disk on first fetch and replays it
 * afterwards. With a warm cache the pipeline runs fully offline and
 * deterministically, which is what makes on-device optimisation practical.
 *
 * Layout (per address slug):
 *
 *   output/api-cache/<slug>/
 *     manifest.json          recorded-at, mode, per-entry byte sizes
 *     geocode.json           JSON responses, one file per fetcher+args
 *     osm.json
 *     osm-siblings-60.json
 *     osm-parts-100.json
 *     solar.json
 *     smarty.json
 *     blobs/<sha1>.bin       image bytes (Street View panes, satellite crops)
 *
 * `null` is a legitimate cached value (e.g. "OSM has no building here"), so
 * entries wrap their payload: `{"v": <value>}`. A missing FILE means
 * not-yet-fetched; a file containing `{"v": null}` means "fetched, and the
 * answer was nothing".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export type CacheMode =
  /** Serve from cache when present, otherwise fetch and record. Default. */
  | 'auto'
  /** Ignore existing entries; fetch everything fresh and overwrite. */
  | 'refresh'
  /** Never touch the network. A cache miss throws. */
  | 'offline'
  /** Disable the cache entirely (original behaviour). */
  | 'off';

export function parseCacheMode(raw: string | null | undefined): CacheMode {
  switch ((raw ?? '').toLowerCase()) {
    case 'refresh': return 'refresh';
    case 'offline': case 'replay': return 'offline';
    case 'off': case 'none': return 'off';
    default: return 'auto';
  }
}

export class CacheMissError extends Error {
  constructor(key: string) {
    super(`api-cache: offline mode and no cached entry for "${key}". `
      + `Run once with --cache-mode auto (online) to record it.`);
    this.name = 'CacheMissError';
  }
}

export interface ApiCacheStats {
  hits: number;
  misses: number;
  writes: number;
  /** Keys served from cache — useful for provenance logging. */
  readonly keys: string[];
}

/** Bytes-typed values are stored as blobs; everything else as JSON. */
type Jsonish = unknown;

export class ApiCache {
  readonly dir: string;
  readonly mode: CacheMode;
  readonly stats: ApiCacheStats = { hits: 0, misses: 0, writes: 0, keys: [] };

  constructor(rootDir: string, slug: string, mode: CacheMode) {
    this.dir = join(rootDir, slug);
    this.mode = mode;
    if (mode !== 'off') mkdirSync(join(this.dir, 'blobs'), { recursive: true });
  }

  private pathFor(key: string): string {
    // Keys are fetcher-derived and already filesystem-safe, but a stray
    // separator would escape the cache dir — normalise defensively.
    return join(this.dir, `${key.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
  }

  /**
   * Memoise one JSON-serialisable API response.
   *
   * `null` round-trips correctly: it is stored as `{"v":null}`, so a cached
   * "no building here" is not mistaken for a cache miss.
   */
  async json<T extends Jsonish>(key: string, fetcher: () => Promise<T>): Promise<T> {
    if (this.mode === 'off') return fetcher();
    const file = this.pathFor(key);
    if (this.mode !== 'refresh' && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { v: T };
        this.stats.hits++;
        this.stats.keys.push(key);
        return parsed.v;
      } catch {
        // Corrupt entry — fall through and re-fetch (unless offline).
      }
    }
    if (this.mode === 'offline') throw new CacheMissError(key);
    this.stats.misses++;
    const value = await fetcher();
    writeFileSync(file, JSON.stringify({ v: value }, null, 2));
    this.stats.writes++;
    return value;
  }

  /**
   * Memoise binary payloads (Street View panes, satellite crops). The bytes
   * live in `blobs/<sha1>.bin`; the key file records which blob it resolved
   * to, so identical imagery fetched under several keys is stored once.
   */
  async bytes(key: string, fetcher: () => Promise<Uint8Array>): Promise<Uint8Array> {
    if (this.mode === 'off') return fetcher();
    const file = this.pathFor(key);
    if (this.mode !== 'refresh' && existsSync(file)) {
      try {
        const { blob } = JSON.parse(readFileSync(file, 'utf8')) as { blob: string };
        const blobPath = join(this.dir, 'blobs', blob);
        if (existsSync(blobPath)) {
          this.stats.hits++;
          this.stats.keys.push(key);
          return new Uint8Array(readFileSync(blobPath));
        }
      } catch {
        // fall through
      }
    }
    if (this.mode === 'offline') throw new CacheMissError(key);
    this.stats.misses++;
    const value = await fetcher();
    const sha = createHash('sha1').update(value).digest('hex').slice(0, 16);
    writeFileSync(join(this.dir, 'blobs', `${sha}.bin`), value);
    writeFileSync(file, JSON.stringify({ blob: `${sha}.bin`, bytes: value.length }, null, 2));
    this.stats.writes++;
    return value;
  }

  /** True when this address has any recorded entries. */
  get warm(): boolean {
    if (!existsSync(this.dir)) return false;
    return readdirSync(this.dir).some(f => f.endsWith('.json') && f !== 'manifest.json');
  }

  /** Persist a manifest so a cache directory is self-describing. */
  writeManifest(address: string): void {
    if (this.mode === 'off') return;
    const entries: Record<string, number> = {};
    let blobBytes = 0;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json') || f === 'manifest.json') continue;
      entries[f.replace(/\.json$/, '')] = statSync(join(this.dir, f)).size;
    }
    const blobDir = join(this.dir, 'blobs');
    if (existsSync(blobDir)) {
      for (const b of readdirSync(blobDir)) blobBytes += statSync(join(blobDir, b)).size;
    }
    writeFileSync(join(this.dir, 'manifest.json'), JSON.stringify({
      address,
      recordedAt: new Date().toISOString(),
      mode: this.mode,
      entries,
      blobBytes,
    }, null, 2));
  }

  summary(): string {
    return `cache ${this.mode}: ${this.stats.hits} hit, ${this.stats.misses} miss, ${this.stats.writes} recorded`;
  }
}

/** Round a coordinate so trivially-different pins share a cache entry. */
export function coordKey(lat: number, lng: number): string {
  return `${lat.toFixed(6)}_${lng.toFixed(6)}`;
}
