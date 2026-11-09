/**
 * BIZ-51 / D-03: a reproducible ZIP. The default writer deflates through the
 * host's CompressionStream, whose output differs between runtimes (zlib version,
 * level), so two builds of one tag could differ by bytes. `deflate` injects a
 * fixed compressor (pako level 9 for releases) and `deterministic` sorts entries.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { deflateRaw } from 'pako';
import { createZip, listZipEntries, extractFile } from '../web/src/engine/zip-utils.js';

const realCS = globalThis.CompressionStream;

/** A different (valid) compressor: DEFLATE stored blocks only. */
class StoredBlocksCompressionStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  constructor() {
    const parts: Uint8Array[] = [];
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { ctl = c; } });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => { parts.push(chunk); },
      close: () => {
        const n = parts.reduce((s, p) => s + p.length, 0);
        const all = new Uint8Array(n);
        let o = 0;
        for (const p of parts) { all.set(p, o); o += p.length; }
        // One stored block (max 65535 bytes) per slice; the last has BFINAL set.
        const slices = Math.max(1, Math.ceil(n / 65535));
        for (let i = 0; i < slices; i++) {
          const s = all.subarray(i * 65535, (i + 1) * 65535);
          const h = new Uint8Array(5);
          h[0] = i === slices - 1 ? 1 : 0;
          h[1] = s.length & 0xff; h[2] = s.length >> 8;
          h[3] = ~s.length & 0xff; h[4] = (~s.length >> 8) & 0xff;
          ctl.enqueue(h); ctl.enqueue(s);
        }
        ctl.close();
      },
    });
  }
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const FILES = [
  { name: 'b/manifest.json', data: text('{"a":1}'.repeat(200)) },
  { name: 'a/scripts/main.js', data: text('export const x = 1;\n'.repeat(300)) },
];
const pako9 = (d: Uint8Array): Uint8Array => deflateRaw(d, { level: 9 });

afterEach(() => { globalThis.CompressionStream = realCS; });

describe('zip-deterministic', () => {
  it('pako deflate yields identical archives regardless of CompressionStream', async () => {
    const opts = { deterministic: true, deflate: pako9 };
    const withNative = await createZip(FILES, opts);
    // @ts-expect-error substitute compressor for the test
    globalThis.CompressionStream = StoredBlocksCompressionStream;
    const withOther = await createZip(FILES, opts);
    expect(sha(withOther)).toBe(sha(withNative));

    // Without the hook the archives follow the runtime's compressor and differ.
    const plainOther = await createZip(FILES, { deterministic: true });
    globalThis.CompressionStream = realCS;
    const plainNative = await createZip(FILES, { deterministic: true });
    expect(sha(plainOther)).not.toBe(sha(plainNative));
  });

  it('entries are written in name order under deterministic', async () => {
    const zip = await createZip(FILES, { deterministic: true, deflate: pako9 });
    expect(listZipEntries(zip.buffer as ArrayBuffer)).toEqual(['a/scripts/main.js', 'b/manifest.json']);
    const plain = await createZip(FILES);
    expect(listZipEntries(plain.buffer as ArrayBuffer)).toEqual(['b/manifest.json', 'a/scripts/main.js']);
  });

  it('the archive still opens through the existing reader', async () => {
    const zip = await createZip(FILES, { deterministic: true, deflate: pako9 });
    const ab = zip.buffer as ArrayBuffer;
    for (const f of FILES) {
      expect(new Uint8Array(await extractFile(ab, f.name))).toEqual(f.data);
    }
  });
});
