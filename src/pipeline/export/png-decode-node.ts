/**
 * Node-only PNG decoder leaf module.
 *
 * Isolated from `photogrammetry-recolor.ts` so the browser bundle never
 * pulls in `pureimage` + `node:stream`. Vite externalizes `node:stream`
 * into a throwing stub for the browser, so importing it from a
 * browser-reachable module is a latent runtime crash. By moving the
 * `pureimage`/`node:stream` usage into this leaf and only reaching it via a
 * `/* @vite-ignore *‍/`-marked dynamic import on the Node code path, vite
 * neither bundles nor warns about it, and the browser never evaluates it.
 *
 * The browser PNG path uses `createImageBitmap` + `OffscreenCanvas` (see
 * `decodeTexture` in `photogrammetry-recolor.ts`) instead.
 */

export interface DecodedTexture {
  width: number;
  height: number;
  /** RGBA pixel buffer. */
  pixels: Uint8Array;
}

/**
 * Decode a PNG byte buffer into RGBA pixels using `pureimage` (a pure-JS
 * decoder that consumes a Node `Readable` stream). Node/Bun only — the
 * browser must not call this (no `node:stream`).
 *
 * Returns null on any decode failure so callers can fall back gracefully.
 */
export async function decodePngNode(bytes: Uint8Array): Promise<DecodedTexture | null> {
  try {
    const pi = await import('pureimage');
    // pureimage works with streams; wrap bytes in a Node Readable.
    const { Readable } = await import('node:stream');
    const buf = Buffer.from(bytes);
    const stream = Readable.from(buf);
    const img = await pi.decodePNGFromStream(stream);
    const w = img.width;
    const h = img.height;
    const pixels = new Uint8Array(w * h * 4);
    // Read RGBA (pureimage stores as int32 ABGR; we re-pack to R,G,B,A).
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = img.getPixelRGBA(x, y);
        const i = (y * w + x) * 4;
        pixels[i]     = (px >>> 24) & 0xff; // R
        pixels[i + 1] = (px >>> 16) & 0xff; // G
        pixels[i + 2] = (px >>>  8) & 0xff; // B
        pixels[i + 3] = px & 0xff;          // A
      }
    }
    return { width: w, height: h, pixels };
  } catch {
    return null;
  }
}
