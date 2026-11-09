/**
 * BYOM corpus manifest + polite fetcher (BIZ-48 / WP B29). The fetcher core is exercised with an injected fetch and a
 * fake clock, so no test touches the network or the disk.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import {
  validateManifest,
  isImportOnly,
  isInsideCorpus,
  corpusDirFor,
  safeFileName,
  type CorpusEntry,
} from '../web/src/engine/byom/corpus-manifest';
import {
  PoliteClient,
  parseRobots,
  fetchEntry,
  type FetchLike,
  type FileSink,
  type FetchContext,
} from '../scripts/byom-corpus-fetch';

const manifestPath = path.resolve(__dirname, 'fixtures/byom-corpus.manifest.json');
const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));

/** A fake clock: `sleep` advances `now`, so spacing is measurable without waiting. */
function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const res = (status: number, body = '', headers: Record<string, string> = {}) =>
  new Response(status === 204 || status === 304 ? null : body, { status, headers });

/** Routes by URL substring; records every request with the fake clock's time. */
function router(clock: { now(): number }, routes: Record<string, () => Response>) {
  const log: { url: string; at: number }[] = [];
  const fetchFn: FetchLike = async (url) => {
    log.push({ url, at: clock.now() });
    for (const [key, make] of Object.entries(routes)) if (url.includes(key)) return make();
    return res(404, 'not found');
  };
  return { fetchFn, log };
}

function memorySink(): FileSink & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return { files, write: async (rel, data) => void files.set(rel, data) };
}

function ctxFor(fetchFn: FetchLike, clock: ReturnType<typeof fakeClock>, extra: Partial<FetchContext> = {}) {
  const sink = memorySink();
  const printed: string[] = [];
  const client = new PoliteClient({ fetch: fetchFn, now: clock.now, sleep: clock.sleep });
  const ctx: FetchContext = { client, sink, print: (s) => void printed.push(s), includeUnlicensed: false, ...extra };
  return { ctx, sink, printed };
}

const directEntry = (over: Partial<CorpusEntry> = {}): CorpusEntry => ({
  id: 'F01',
  kind: 'model',
  title: 'Example Car',
  author: 'A',
  url: 'https://example.test/models/car.ldr',
  licence: 'CC BY 4.0',
  role: 'orig',
  fetch: { type: 'direct' },
  notes: 'test',
  ...over,
});

describe('byom corpus manifest', () => {
  it('every manifest entry has a url, licence and kind, and no path outside data/byom-corpus', () => {
    expect(manifest.errors).toEqual([]);
    expect(manifest.entries.length).toBe(82);
    for (const e of manifest.entries) {
      expect(e.url.startsWith('https://')).toBe(true);
      expect(e.licence.length).toBeGreaterThan(0);
      expect(['model', 'photos']).toContain(e.kind);
      expect(isInsideCorpus(`${corpusDirFor(e)}/anything.bin`)).toBe(true);
    }
    expect(isInsideCorpus('data/byom-corpus/files/F01/../../../x')).toBe(false);
    expect(isInsideCorpus('../data/byom-corpus/x')).toBe(false);
    expect(isInsideCorpus('/data/byom-corpus/x')).toBe(false);
    expect(safeFileName('../../evil/..\\x.ldr')).not.toMatch(/[\\/]|^\./);
  });

  it('counts 41 model files and 41 photo sets', () => {
    expect(manifest.entries.filter((e) => e.kind === 'model').length).toBe(41);
    expect(manifest.entries.filter((e) => e.kind === 'photos').length).toBe(41);
  });

  it('an entry with licence "not stated" is marked import-only', () => {
    expect(isImportOnly({ licence: 'not stated' })).toBe(true);
    expect(isImportOnly({ licence: 'not stated; third-party upload' })).toBe(true);
    expect(isImportOnly({ licence: 'CC BY 4.0' })).toBe(false);
    expect(isImportOnly({ licence: 'CC BY 4.0', importOnly: true })).toBe(true);
    const f04 = manifest.entries.find((e) => e.id === 'F04')!;
    expect(isImportOnly(f04)).toBe(true);
    const f02 = manifest.entries.find((e) => e.id === 'F02')!;
    expect(isImportOnly(f02)).toBe(false);
  });

  it('rejects a malformed entry by naming it', () => {
    const v = validateManifest({ entries: [{ id: 'X1', kind: 'model', url: 'http://x' }] });
    expect(v.errors.length).toBeGreaterThan(3);
    expect(v.errors.every((m) => m.startsWith('X1:'))).toBe(true);
  });
});

describe('byom corpus fetcher', () => {
  it('a 4xx response is recorded as unresolved with its status, never as absent', async () => {
    const clock = fakeClock();
    const { fetchFn } = router(clock, { 'robots.txt': () => res(404) }); // everything else: 404
    const { ctx, sink } = ctxFor(fetchFn, clock);
    const r = await fetchEntry(directEntry(), ctx);
    expect(r.status).toBe('unresolved');
    expect(r.httpStatus).toBe(404);
    expect(r.files).toEqual([]);
    expect(sink.files.size).toBe(0);
  });

  it('a manual item prints steps and downloads nothing', async () => {
    const clock = fakeClock();
    const { fetchFn, log } = router(clock, {});
    const { ctx, printed } = ctxFor(fetchFn, clock);
    const entry = directEntry({ id: 'F12', fetch: undefined, manual: 'Open the page, log in yourself, press Download.' });
    const r = await fetchEntry(entry, ctx);
    expect(r.status).toBe('manual');
    expect(log).toEqual([]);
    expect(printed.join('\n')).toContain('Open the page, log in yourself, press Download.');
    expect(printed.join('\n')).toContain('data/byom-corpus/files/F12');
  });

  it('requests are at least 2.5 s apart', async () => {
    const clock = fakeClock();
    const { fetchFn, log } = router(clock, {
      'robots.txt': () => res(404),
      'a.ldr': () => res(200, '0 a'),
      'b.ldr': () => res(200, '0 b'),
    });
    const client = new PoliteClient({ fetch: fetchFn, now: clock.now, sleep: clock.sleep });
    await client.get('https://example.test/a.ldr');
    await client.get('https://example.test/b.ldr');
    expect(log.length).toBe(3); // robots, a, b
    for (let i = 1; i < log.length; i++) expect(log[i].at - log[i - 1].at).toBeGreaterThanOrEqual(2500);
  });

  it('a direct item is written under its id with sha256, licence and no path escape', async () => {
    const clock = fakeClock();
    const { fetchFn } = router(clock, { 'robots.txt': () => res(404), 'car.ldr': () => res(200, '0 car\n') });
    const { ctx, sink } = ctxFor(fetchFn, clock);
    const r = await fetchEntry(directEntry(), ctx);
    expect(r.status).toBe('fetched');
    expect(r.files.length).toBe(1);
    expect(r.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.files[0].licence).toBe('CC BY 4.0');
    expect([...sink.files.keys()]).toEqual(['data/byom-corpus/files/F01/car.ldr']);
  });

  it('robots.txt disallowing the path skips the item with the reason and fetches nothing', async () => {
    const clock = fakeClock();
    const { fetchFn, log } = router(clock, { 'robots.txt': () => res(200, 'User-agent: *\nDisallow: /models/\n') });
    const { ctx } = ctxFor(fetchFn, clock);
    const r = await fetchEntry(directEntry(), ctx);
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/robots/i);
    expect(log.filter((l) => !l.url.includes('robots.txt'))).toEqual([]);
  });

  it('an item whose licence is not stated is skipped by default and fetched with includeUnlicensed', async () => {
    const entry = directEntry({ licence: 'not stated' });
    const mk = () => {
      const clock = fakeClock();
      const { fetchFn } = router(clock, { 'robots.txt': () => res(404), 'car.ldr': () => res(200, '0 x') });
      return { clock, fetchFn };
    };
    const a = mk();
    const skipped = await fetchEntry(entry, ctxFor(a.fetchFn, a.clock).ctx);
    expect(skipped.status).toBe('skipped');
    expect(skipped.reason).toMatch(/licence/i);
    const b = mk();
    const got = await fetchEntry(entry, ctxFor(b.fetchFn, b.clock, { includeUnlicensed: true }).ctx);
    expect(got.status).toBe('fetched');
    expect(got.files[0].importOnly).toBe(true);
  });

  it('a 429 waits out the Retry-After window and then succeeds', async () => {
    const clock = fakeClock();
    let calls = 0;
    const { fetchFn, log } = router(clock, {
      'robots.txt': () => res(404),
      'car.ldr': () => (++calls === 1 ? res(429, 'slow down', { 'retry-after': '90' }) : res(200, '0 car')),
    });
    const { ctx } = ctxFor(fetchFn, clock);
    const r = await fetchEntry(directEntry(), ctx);
    expect(r.status).toBe('fetched');
    const carCalls = log.filter((l) => l.url.includes('car.ldr'));
    expect(carCalls.length).toBe(2);
    expect(carCalls[1].at - carCalls[0].at).toBeGreaterThanOrEqual(90_000);
  });

  it('a login redirect or an HTML page where a model file was expected is unresolved, not a download', async () => {
    const clock = fakeClock();
    const { fetchFn } = router(clock, {
      'robots.txt': () => res(404),
      'car.ldr': () => res(200, '<html>Please log in</html>', { 'content-type': 'text/html' }),
    });
    const { ctx, sink } = ctxFor(fetchFn, clock);
    const r = await fetchEntry(directEntry(), ctx);
    expect(r.status).toBe('unresolved');
    expect(r.reason).toMatch(/html|login|terms/i);
    expect(sink.files.size).toBe(0);
  });

  it('a Commons category records the licence read from imageinfo per file and skips non-free files', async () => {
    const clock = fakeClock();
    const api = {
      query: {
        pages: {
          '1': {
            title: 'File:Good one.jpg',
            imageinfo: [
              {
                thumburl: 'https://upload.wikimedia.org/thumb/good.jpg',
                url: 'https://upload.wikimedia.org/orig/good.jpg',
                mime: 'image/jpeg',
                thumbwidth: 1280,
                thumbheight: 960,
                extmetadata: {
                  LicenseShortName: { value: 'CC BY-SA 4.0' },
                  Artist: { value: '<a href="x">Jane Doe</a>' },
                },
              },
            ],
          },
          '2': {
            title: 'File:Fair use.jpg',
            imageinfo: [
              {
                thumburl: 'https://upload.wikimedia.org/thumb/fair.jpg',
                url: 'https://upload.wikimedia.org/orig/fair.jpg',
                mime: 'image/jpeg',
                extmetadata: { LicenseShortName: { value: 'Fair use' } },
              },
            ],
          },
        },
      },
    };
    const { fetchFn, log } = router(clock, {
      'robots.txt': () => res(200, 'User-agent: *\nDisallow: /w/\n'),
      'api.php': () => res(200, JSON.stringify(api), { 'content-type': 'application/json' }),
      'good.jpg': () => res(200, 'JPEGDATA', { 'content-type': 'image/jpeg' }),
    });
    const { ctx } = ctxFor(fetchFn, clock);
    const entry = directEntry({
      id: 'P02',
      kind: 'photos',
      url: 'https://commons.wikimedia.org/wiki/Category:Test',
      licence: 'per file',
      fetch: { type: 'commons-category', category: 'Test', max: 5 },
    });
    const r = await fetchEntry(entry, ctx);
    expect(r.status).toBe('fetched');
    expect(r.files.length).toBe(1);
    expect(r.files[0].licence).toBe('CC BY-SA 4.0');
    expect(r.files[0].author).toBe('Jane Doe');
    expect(r.skippedFiles?.map((s) => s.name)).toEqual(['Fair use.jpg']);
    expect(log.some((l) => l.url.includes('fair.jpg'))).toBe(false);
  });
});

describe('robots.txt parsing', () => {
  it('uses the most specific group, longest match wins, and an empty file allows everything', () => {
    const r = parseRobots('User-agent: *\nDisallow: /a/\nAllow: /a/b\n\nUser-agent: craftmatic-corpus\nDisallow: /z\n', 'craftmatic-corpus');
    expect(r('/z/1')).toBe(false);
    expect(r('/a/1')).toBe(true); // our group has no rule for /a/
    const star = parseRobots('User-agent: *\nDisallow: /a/\nAllow: /a/b\n', 'craftmatic-corpus');
    expect(star('/a/1')).toBe(false);
    expect(star('/a/b')).toBe(true);
    expect(parseRobots('', 'x')('/anything')).toBe(true);
    expect(parseRobots('User-agent: *\nDisallow: /\n', 'x')('/anything')).toBe(false);
    expect(parseRobots('User-agent: *\nDisallow: /*.zip$\n', 'x')('/f.zip')).toBe(false);
  });
});
