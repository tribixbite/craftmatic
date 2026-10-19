import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiCache, CacheMissError, parseCacheMode, coordKey } from './api-cache.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cm-apicache-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('parseCacheMode', () => {
  it('defaults to auto and accepts the documented aliases', () => {
    expect(parseCacheMode(undefined)).toBe('auto');
    expect(parseCacheMode('')).toBe('auto');
    expect(parseCacheMode('nonsense')).toBe('auto');
    expect(parseCacheMode('refresh')).toBe('refresh');
    expect(parseCacheMode('offline')).toBe('offline');
    expect(parseCacheMode('replay')).toBe('offline');
    expect(parseCacheMode('OFF')).toBe('off');
    expect(parseCacheMode('none')).toBe('off');
  });
});

describe('ApiCache.json', () => {
  it('fetches once, then replays without calling the fetcher again', async () => {
    const c = new ApiCache(root, 'flatiron', 'auto');
    let calls = 0;
    const fetcher = async (): Promise<{ id: number }> => { calls++; return { id: 42 }; };
    expect(await c.json('osm', fetcher)).toEqual({ id: 42 });
    expect(calls).toBe(1);

    const c2 = new ApiCache(root, 'flatiron', 'auto');
    expect(await c2.json('osm', fetcher)).toEqual({ id: 42 });
    expect(calls).toBe(1);            // served from disk
    expect(c2.stats.hits).toBe(1);
  });

  it('round-trips null — a cached "no building here" is not a miss', async () => {
    const c = new ApiCache(root, 'x', 'auto');
    let calls = 0;
    const fetcher = async (): Promise<null> => { calls++; return null; };
    expect(await c.json('osm', fetcher)).toBeNull();
    const c2 = new ApiCache(root, 'x', 'auto');
    expect(await c2.json('osm', fetcher)).toBeNull();
    expect(calls).toBe(1);
  });

  it('offline mode throws on a miss instead of reaching the network', async () => {
    const c = new ApiCache(root, 'x', 'offline');
    await expect(c.json('osm', async () => {
      throw new Error('network must not be touched');
    })).rejects.toBeInstanceOf(CacheMissError);
  });

  it('offline mode replays a warm entry without any fetcher call', async () => {
    await new ApiCache(root, 'x', 'auto').json('osm', async () => ({ ok: true }));
    const c = new ApiCache(root, 'x', 'offline');
    expect(await c.json('osm', async () => { throw new Error('must not fetch'); }))
      .toEqual({ ok: true });
  });

  it('refresh mode re-fetches and overwrites', async () => {
    await new ApiCache(root, 'x', 'auto').json('osm', async () => ({ v: 1 }));
    const c = new ApiCache(root, 'x', 'refresh');
    expect(await c.json('osm', async () => ({ v: 2 }))).toEqual({ v: 2 });
    const c3 = new ApiCache(root, 'x', 'auto');
    expect(await c3.json('osm', async () => ({ v: 3 }))).toEqual({ v: 2 });
  });

  it('off mode never writes anything to disk', async () => {
    const c = new ApiCache(root, 'x', 'off');
    expect(await c.json('osm', async () => ({ v: 1 }))).toEqual({ v: 1 });
    expect(existsSync(join(root, 'x'))).toBe(false);
  });

  it('re-fetches when an entry is corrupt rather than crashing', async () => {
    const c = new ApiCache(root, 'x', 'auto');
    await c.json('osm', async () => ({ v: 1 }));
    require('node:fs').writeFileSync(join(root, 'x', 'osm.json'), '{ truncated');
    const c2 = new ApiCache(root, 'x', 'auto');
    expect(await c2.json('osm', async () => ({ v: 9 }))).toEqual({ v: 9 });
  });
});

describe('ApiCache.bytes', () => {
  const img = new Uint8Array([1, 2, 3, 4, 5]);

  it('stores image payloads as blobs and replays them byte-identically', async () => {
    const c = new ApiCache(root, 'x', 'auto');
    let calls = 0;
    const got = await c.bytes('sv-img-a', async () => { calls++; return img; });
    expect(Array.from(got)).toEqual([1, 2, 3, 4, 5]);

    const c2 = new ApiCache(root, 'x', 'auto');
    const replayed = await c2.bytes('sv-img-a', async () => { calls++; return img; });
    expect(Array.from(replayed)).toEqual(Array.from(img));
    expect(calls).toBe(1);
  });

  it('deduplicates identical imagery across keys', async () => {
    const c = new ApiCache(root, 'x', 'auto');
    await c.bytes('sv-a', async () => img);
    await c.bytes('sv-b', async () => img);
    const blobs = require('node:fs').readdirSync(join(root, 'x', 'blobs')) as string[];
    expect(blobs.length).toBe(1); // same sha1 → one blob, two key files
  });

  it('offline mode throws on a blob miss', async () => {
    const c = new ApiCache(root, 'x', 'offline');
    await expect(c.bytes('sv-a', async () => img)).rejects.toBeInstanceOf(CacheMissError);
  });
});

describe('ApiCache bookkeeping', () => {
  it('reports warm only after something is recorded', async () => {
    const c = new ApiCache(root, 'x', 'auto');
    expect(c.warm).toBe(false);
    await c.json('geocode', async () => ({ lat: 1 }));
    expect(new ApiCache(root, 'x', 'auto').warm).toBe(true);
  });

  it('writes a self-describing manifest', async () => {
    const c = new ApiCache(root, 'x', 'auto');
    await c.json('geocode', async () => ({ lat: 1 }));
    await c.bytes('sv-a', async () => new Uint8Array([7, 7, 7]));
    c.writeManifest('175 5th Ave');
    const m = JSON.parse(readFileSync(join(root, 'x', 'manifest.json'), 'utf8')) as {
      address: string; entries: Record<string, number>; blobBytes: number;
    };
    expect(m.address).toBe('175 5th Ave');
    expect(Object.keys(m.entries)).toContain('geocode');
    expect(m.blobBytes).toBe(3);
  });

  it('keeps cache keys inside the cache directory', async () => {
    // Path separators collapse to underscores, so a traversal-looking key
    // becomes an ordinary filename INSIDE the cache dir. The invariant that
    // matters is that nothing is written outside it.
    const c = new ApiCache(root, 'x', 'auto');
    await c.json('../../escape', async () => ({ v: 1 }));
    expect(existsSync(join(root, 'x', '.._.._escape.json'))).toBe(true);
    expect(existsSync(join(root, 'escape.json'))).toBe(false);
    expect(existsSync(join(root, '..', 'escape.json'))).toBe(false);
  });
});

describe('coordKey', () => {
  it('is stable to sub-micro-degree jitter', () => {
    expect(coordKey(40.74110000001, -73.98970000001)).toBe(coordKey(40.7411, -73.9897));
  });
  it('separates genuinely different pins', () => {
    expect(coordKey(40.7411, -73.9897)).not.toBe(coordKey(40.7412, -73.9897));
  });
});
