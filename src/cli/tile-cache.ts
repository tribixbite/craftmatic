/**
 * File-based cache for Google 3D Tiles GLB captures.
 *
 * Google 3D Tiles are non-deterministic -- same coordinates can produce different
 * geometry across runs due to LOD selection, tile availability, and server-side
 * updates. This cache stores GLBs by coordinate+radius hash, ensuring reproducible
 * pipeline runs and avoiding unnecessary re-downloads.
 *
 * Cache directory: ~/.craftmatic/tiles-cache/
 * Each entry: <hash>.glb + <hash>.meta.json sidecar
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CACHE_DIR = join(homedir(), '.craftmatic', 'tiles-cache');

/** Default cache TTL: 30 days */
const CACHE_TTL_DAYS = 30;

/** Metadata sidecar stored alongside each cached GLB */
export interface TileCacheEntry {
  /** Latitude of capture center */
  lat: number;
  /** Longitude of capture center */
  lng: number;
  /** Capture radius in meters */
  radius: number;
  /** ISO timestamp of when this GLB was cached */
  capturedAt: string;
  /** Absolute path to the cached GLB file */
  glbPath: string;
  /** Size of the GLB in bytes */
  sizeBytes: number;
}

/**
 * Generate a deterministic cache key from coordinates and radius.
 * Uses 5 decimal places (~1.1m precision at equator) -- sufficient for
 * building-level queries where capture radius is 20-150m.
 */
function cacheKey(lat: number, lng: number, radius: number): string {
  return `${lat.toFixed(5)}_${lng.toFixed(5)}_r${radius}`;
}

/** Ensure the cache directory exists (lazy init on first use) */
function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Get cached GLB path for coordinates, or null if not cached / expired.
 * Checks both file existence and TTL expiry.
 */
export function getCachedTile(lat: number, lng: number, radius: number): TileCacheEntry | null {
  const key = cacheKey(lat, lng, radius);
  const metaPath = join(CACHE_DIR, `${key}.meta.json`);
  const glbPath = join(CACHE_DIR, `${key}.glb`);

  if (!existsSync(metaPath) || !existsSync(glbPath)) {
    return null;
  }

  try {
    const meta: TileCacheEntry = JSON.parse(readFileSync(metaPath, 'utf-8'));
    const capturedAt = new Date(meta.capturedAt);
    const ageMs = Date.now() - capturedAt.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays > CACHE_TTL_DAYS) {
      // Expired -- caller should re-capture
      return null;
    }

    // Verify the GLB still exists and matches recorded size
    const stat = statSync(glbPath);
    if (stat.size !== meta.sizeBytes) {
      // Corrupted or truncated -- treat as miss
      return null;
    }

    // Return entry with absolute path to cached GLB
    return { ...meta, glbPath };
  } catch {
    // JSON parse error or stat error -- treat as miss
    return null;
  }
}

/**
 * Store a GLB in the cache. Copies the file (does not move the original).
 * @returns Absolute path to the cached GLB copy.
 */
export async function cacheTile(lat: number, lng: number, radius: number, glbPath: string): Promise<string> {
  ensureCacheDir();

  const key = cacheKey(lat, lng, radius);
  const cachedGlbPath = join(CACHE_DIR, `${key}.glb`);
  const metaPath = join(CACHE_DIR, `${key}.meta.json`);

  // Copy GLB to cache directory (preserve original at source location)
  copyFileSync(glbPath, cachedGlbPath);

  const stat = statSync(cachedGlbPath);
  const entry: TileCacheEntry = {
    lat,
    lng,
    radius,
    capturedAt: new Date().toISOString(),
    glbPath: cachedGlbPath,
    sizeBytes: stat.size,
  };

  writeFileSync(metaPath, JSON.stringify(entry, null, 2));
  return cachedGlbPath;
}

/**
 * List all cached tile entries (non-expired).
 * Reads all .meta.json files in the cache directory.
 */
export function listCachedTiles(): TileCacheEntry[] {
  if (!existsSync(CACHE_DIR)) return [];

  const entries: TileCacheEntry[] = [];
  const files = readdirSync(CACHE_DIR);

  for (const file of files) {
    if (!file.endsWith('.meta.json')) continue;

    const metaPath = join(CACHE_DIR, file);
    try {
      const meta: TileCacheEntry = JSON.parse(readFileSync(metaPath, 'utf-8'));
      const glbPath = metaPath.replace('.meta.json', '.glb');

      if (!existsSync(glbPath)) continue;

      const capturedAt = new Date(meta.capturedAt);
      const ageDays = (Date.now() - capturedAt.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > CACHE_TTL_DAYS) continue;

      entries.push({ ...meta, glbPath });
    } catch {
      // Skip malformed entries
    }
  }

  return entries;
}

/**
 * Clear tiles older than the specified age (default: CACHE_TTL_DAYS).
 * Removes both the GLB and its metadata sidecar.
 * @returns Number of entries pruned.
 */
export function pruneTileCache(maxAgeDays = CACHE_TTL_DAYS): number {
  if (!existsSync(CACHE_DIR)) return 0;

  let pruned = 0;
  const files = readdirSync(CACHE_DIR);

  for (const file of files) {
    if (!file.endsWith('.meta.json')) continue;

    const metaPath = join(CACHE_DIR, file);
    try {
      const meta: TileCacheEntry = JSON.parse(readFileSync(metaPath, 'utf-8'));
      const capturedAt = new Date(meta.capturedAt);
      const ageDays = (Date.now() - capturedAt.getTime()) / (1000 * 60 * 60 * 24);

      if (ageDays > maxAgeDays) {
        const glbPath = metaPath.replace('.meta.json', '.glb');
        try { unlinkSync(glbPath); } catch { /* GLB already gone */ }
        try { unlinkSync(metaPath); } catch { /* meta already gone */ }
        pruned++;
      }
    } catch {
      // Skip malformed entries
    }
  }

  return pruned;
}

/**
 * Get human-readable cache info summary for --cache-info flag.
 */
export function getCacheInfo(): string {
  const entries = listCachedTiles();
  if (entries.length === 0) {
    return `Tile cache: empty (dir: ${CACHE_DIR})`;
  }

  const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  const oldest = entries.reduce((min, e) =>
    new Date(e.capturedAt) < new Date(min.capturedAt) ? e : min,
  );
  const newest = entries.reduce((max, e) =>
    new Date(e.capturedAt) > new Date(max.capturedAt) ? e : max,
  );
  const oldestAge = (Date.now() - new Date(oldest.capturedAt).getTime()) / (1000 * 60 * 60 * 24);
  const newestAge = (Date.now() - new Date(newest.capturedAt).getTime()) / (1000 * 60 * 60 * 24);

  const lines = [
    `Tile cache: ${entries.length} entries, ${(totalBytes / (1024 * 1024)).toFixed(1)} MB total`,
    `  Dir: ${CACHE_DIR}`,
    `  Oldest: ${oldestAge.toFixed(1)} days ago`,
    `  Newest: ${newestAge.toFixed(1)} days ago`,
    `  TTL: ${CACHE_TTL_DAYS} days`,
    '',
    '  Entries:',
  ];

  for (const e of entries) {
    const age = (Date.now() - new Date(e.capturedAt).getTime()) / (1000 * 60 * 60 * 24);
    lines.push(`    ${e.lat.toFixed(5)}, ${e.lng.toFixed(5)} r=${e.radius}m — ${(e.sizeBytes / (1024 * 1024)).toFixed(1)} MB, ${age.toFixed(1)} days old`);
  }

  return lines.join('\n');
}
